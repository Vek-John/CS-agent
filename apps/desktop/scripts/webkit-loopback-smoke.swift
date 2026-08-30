import AppKit
import Foundation
import WebKit

private struct SmokeInput: Decodable {
    let appOrigin: String
    let viewerOrigin: String
    let sessionToken: String
    let wasmPath: String
    let demoPath: String?
    let snapshotPath: String?
}

private final class SmokeRunner: NSObject, WKNavigationDelegate, WKUIDelegate {
    private enum Phase { case app, viewer }

    private let input: SmokeInput
    private let webView: WKWebView
    private var phase = Phase.app
    private var appResult: [String: Any]?
    private var viewerResult: [String: Any]?
    private var finished = false
    private var demoDeadline = Date.distantPast

    init(input: SmokeInput) {
        self.input = input
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        self.webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 800), configuration: configuration)
        super.init()
        self.webView.navigationDelegate = self
        self.webView.uiDelegate = self
    }

    func start() {
        guard let appURL = URL(string: "\(input.appOrigin)/desktop"),
              let cookie = HTTPCookie(properties: [
                .name: "cs_agent_runtime",
                .value: input.sessionToken,
                .domain: "127.0.0.1",
                .path: "/",
                .expires: Date(timeIntervalSinceNow: 120),
                HTTPCookiePropertyKey("HttpOnly"): "TRUE",
                HTTPCookiePropertyKey("SameSite"): "Strict",
              ]) else {
            fail("WEBKIT_INPUT_INVALID")
            return
        }
        webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
            self?.webView.load(URLRequest(url: appURL, cachePolicy: .reloadIgnoringLocalCacheData))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + (input.demoPath == nil ? 40 : 120)) { [weak self] in
            self?.fail("WEBKIT_TIMEOUT")
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        switch phase {
        case .app:
            inspectApp()
        case .viewer:
            inspectViewer()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("WEBKIT_NAVIGATION_FAILED")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("WEBKIT_NAVIGATION_FAILED")
    }

    private func inspectApp() {
        let script = """
        const frame = document.querySelector('iframe');
        return {
          origin: location.origin,
          readyForDemo: document.body.innerText.includes('请选择本地 Demo'),
          iframeUrl: frame?.src ?? '',
          scriptCount: document.scripts.length,
          stylesheetCount: document.querySelectorAll('link[rel="stylesheet"]').length
        };
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                guard let object = value as? [String: Any],
                      object["origin"] as? String == self.input.appOrigin,
                      object["readyForDemo"] as? Bool == true,
                      let iframe = object["iframeUrl"] as? String,
                      iframe.hasPrefix("\(self.input.viewerOrigin)/"),
                      iframe.contains("parentOrigin="),
                      (object["scriptCount"] as? Int ?? 0) > 0,
                      (object["stylesheetCount"] as? Int ?? 0) > 0 else {
                    self.fail("WEBKIT_APP_ASSERTION_FAILED")
                    return
                }
                self.appResult = object
                self.captureSnapshotIfRequested { [weak self] in self?.loadViewer() }
            case .failure:
                self.fail("WEBKIT_APP_SCRIPT_FAILED")
            }
        }
    }

    private func captureSnapshotIfRequested(completion: @escaping () -> Void) {
        guard let path = input.snapshotPath else {
            completion()
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
            guard let self else { return }
            self.webView.takeSnapshot(with: nil) { [weak self] image, error in
                guard let self else { return }
                guard error == nil,
                      let image,
                      let tiff = image.tiffRepresentation,
                      let bitmap = NSBitmapImageRep(data: tiff),
                      let png = bitmap.representation(using: .png, properties: [:]) else {
                    self.fail("WEBKIT_SNAPSHOT_FAILED")
                    return
                }
                do {
                    try png.write(to: URL(fileURLWithPath: path), options: .atomic)
                    completion()
                } catch {
                    self.fail("WEBKIT_SNAPSHOT_FAILED")
                }
            }
        }
    }

    private func loadViewer() {
        phase = .viewer
        guard let encodedParent = input.appOrigin.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let viewerURL = URL(string: "\(input.viewerOrigin)/cs2d/?host=1&parentOrigin=\(encodedParent)") else {
            fail("WEBKIT_INPUT_INVALID")
            return
        }
        webView.load(URLRequest(url: viewerURL, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    private func inspectViewer() {
        let script = """
        const response = await fetch(wasmPath, { cache: 'no-store' });
        const bytes = await response.arrayBuffer();
        await WebAssembly.compile(bytes);
        const workerOk = await new Promise((resolve) => {
          const source = URL.createObjectURL(new Blob(['postMessage("ok")'], { type: 'text/javascript' }));
          const worker = new Worker(source, { type: 'module' });
          const timer = setTimeout(() => { worker.terminate(); URL.revokeObjectURL(source); resolve(false); }, 5000);
          worker.onmessage = (event) => {
            clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(source); resolve(event.data === 'ok');
          };
          worker.onerror = () => {
            clearTimeout(timer); worker.terminate(); URL.revokeObjectURL(source); resolve(false);
          };
        });
        return {
          origin: location.origin,
          titlePresent: document.title.length > 0,
          scriptCount: document.scripts.length,
          assetCount: performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/cs2d/assets/')).length,
          wasmBytes: bytes.byteLength,
          workerOk,
          crossOriginIsolated: globalThis.crossOriginIsolated === true,
          sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
          sessionCookieVisible: document.cookie.includes('cs_agent_runtime=')
        };
        """
        webView.callAsyncJavaScript(
            script,
            arguments: ["wasmPath": input.wasmPath],
            in: nil,
            in: .page
        ) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let value):
                guard let object = value as? [String: Any],
                      object["origin"] as? String == self.input.viewerOrigin,
                      object["titlePresent"] as? Bool == true,
                      (object["scriptCount"] as? Int ?? 0) > 0,
                      (object["assetCount"] as? Int ?? 0) > 0,
                      (object["wasmBytes"] as? Int ?? 0) > 0,
                      object["workerOk"] as? Bool == true,
                      object["crossOriginIsolated"] as? Bool == true,
                      object["sharedArrayBuffer"] as? Bool == true,
                      object["sessionCookieVisible"] as? Bool == false else {
                    self.fail("WEBKIT_VIEWER_ASSERTION_FAILED")
                    return
                }
                self.viewerResult = object
                if self.input.demoPath == nil {
                    self.succeed(viewer: object, demo: nil)
                } else {
                    self.startDemoParse()
                }
            case .failure:
                self.fail("WEBKIT_VIEWER_SCRIPT_FAILED")
            }
        }
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard let demoPath = input.demoPath else {
            completionHandler(nil)
            return
        }
        completionHandler([URL(fileURLWithPath: demoPath)])
    }

    private func startDemoParse() {
        demoDeadline = Date().addingTimeInterval(90)
        let script = """
        const input = document.querySelector('input[type="file"]');
        if (!input) return false;
        input.click();
        return true;
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            if case .success(let value) = result, value as? Bool == true {
                self.pollDemoSelection()
            } else {
                self.fail("WEBKIT_DEMO_PICKER_FAILED")
            }
        }
    }

    private func pollDemoSelection() {
        if Date() >= demoDeadline {
            fail("WEBKIT_DEMO_PARSE_TIMEOUT")
            return
        }
        let script = """
        const text = document.body.innerText;
        const buttons = [...document.querySelectorAll('button')]
          .filter((button) => button.offsetParent !== null && button.innerText.trim().length > 0);
        return {
          selectionReady: text.includes('选择本场要分析的玩家'),
          parseFailed: text.includes('Demo 解析失败'),
          visibleButtons: buttons.length
        };
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            if case .success(let value) = result, let object = value as? [String: Any] {
                if object["parseFailed"] as? Bool == true {
                    self.fail("WEBKIT_DEMO_PARSE_FAILED")
                    return
                }
                if object["selectionReady"] as? Bool == true,
                   (object["visibleButtons"] as? Int ?? 0) >= 10 {
                    self.selectFirstPlayer()
                    return
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.pollDemoSelection()
            }
        }
    }

    private func selectFirstPlayer() {
        let script = """
        const buttons = [...document.querySelectorAll('button')]
          .filter((button) => button.offsetParent !== null && button.innerText.trim().length > 0);
        const player = buttons.find((button) => !button.innerText.includes('选择'));
        if (!player) return { clicked: false, player: '' };
        const name = player.innerText.trim();
        player.click();
        return { clicked: true, player: name };
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            guard case .success(let value) = result,
                  let clicked = value as? [String: Any],
                  clicked["clicked"] as? Bool == true,
                  let player = clicked["player"] as? String,
                  !player.isEmpty else {
                self.fail("WEBKIT_PLAYER_SELECTION_FAILED")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                self?.verifyDemoStage(player: player)
            }
        }
    }

    private func verifyDemoStage(player: String) {
        let script = """
        return {
          canvasCount: document.querySelectorAll('canvas').length,
          selectionStillVisible: document.body.innerText.includes('选择本场要分析的玩家'),
          route: location.pathname
        };
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self, let viewerResult = self.viewerResult else { return }
            guard case .success(let value) = result,
                  let stage = value as? [String: Any],
                  (stage["canvasCount"] as? Int ?? 0) > 0,
                  stage["selectionStillVisible"] as? Bool == false else {
                self.fail("WEBKIT_DEMO_STAGE_FAILED")
                return
            }
            self.succeed(viewer: viewerResult, demo: [
                "parsed": true,
                "selectedPlayer": player,
                "canvasCount": stage["canvasCount"] as? Int ?? 0,
                "route": stage["route"] as? String ?? "",
            ])
        }
    }

    private func succeed(viewer: [String: Any], demo: [String: Any]?) {
        guard !finished, let appResult else { return }
        finished = true
        var output: [String: Any] = ["ok": true, "app": appResult, "viewer": viewer]
        if let demo { output["demo"] = demo }
        if let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0a]))
        }
        NSApplication.shared.terminate(nil)
    }

    private func fail(_ code: String) {
        guard !finished else { return }
        finished = true
        FileHandle.standardError.write(Data("webkit:smoke \(code)\n".utf8))
        NSApplication.shared.terminate(nil)
    }
}

let inputData = FileHandle.standardInput.readDataToEndOfFile()
guard let input = try? JSONDecoder().decode(SmokeInput.self, from: inputData) else {
    FileHandle.standardError.write(Data("webkit:smoke WEBKIT_INPUT_INVALID\n".utf8))
    exit(1)
}

let application = NSApplication.shared
application.setActivationPolicy(.prohibited)
private let runner = SmokeRunner(input: input)
runner.start()
application.run()
exit(0)
