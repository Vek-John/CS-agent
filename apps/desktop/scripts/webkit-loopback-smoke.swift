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
    let coordinationPath: String?
}

private final class SmokeRunner: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    private enum Phase { case appInitial, appHistory, viewer }

    private let input: SmokeInput
    private let webView: WKWebView
    private var phase = Phase.appInitial
    private var appResult: [String: Any]?
    private var viewerResult: [String: Any]?
    private var demoResult: [String: Any]?
    private var historyResult: [String: Any]?
    private var finished = false
    private var appInspectionStarted = false
    private var historyInspectionStarted = false
    private var pickerWasOpened = false
    private var managedImportTraceEnded = false
    private var managedReviewRowTraced = false
    private var demoDeadline = Date.distantPast
    private var historyDeadline = Date.distantPast
    private var historyRestoreObserved = false
    private var managedStatus = "unobserved"
    private var managedStatusTracedAt = Date.distantPast
    private var historyStatus = "unobserved"
    private var historyStatusTracedAt = Date.distantPast

    init(input: SmokeInput) {
        self.input = input
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let appOrigin = input.appOrigin.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let viewerOrigin = input.viewerOrigin.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        let auditScript = """
        (() => {
          const appOrigin = "\(appOrigin)";
          const viewerOrigin = "\(viewerOrigin)";
          const providerPaths = new Set([
            '/api/coaching/direct',
            '/api/coaching/narrate',
            '/api/coaching/diagnose',
            '/api/coaching/policy',
            '/api/coaching/wrap-up'
          ]);
          const pathFor = (value) => {
            try {
              const raw = typeof value === 'string' || value instanceof URL
                ? String(value)
                : value instanceof Request ? value.url : '';
              const url = new URL(raw, location.href);
              return url.origin === appOrigin ? url.pathname : '';
            } catch { return ''; }
          };
          if (location.origin === appOrigin) {
            const createAudit = () => ({ providerFetch: {}, allApiFetch: {}, providerResources: [] });
            globalThis.__csHistoryNetworkAudit = createAudit();
            globalThis.__csHistoryResetNetworkAudit = () => {
              globalThis.__csHistoryNetworkAudit = createAudit();
              performance.clearResourceTimings();
            };
            const record = (bucket, path) => {
              bucket[path] = (bucket[path] || 0) + 1;
            };
            const originalFetch = globalThis.fetch.bind(globalThis);
            globalThis.fetch = (resource, init) => {
              const path = pathFor(resource);
              const audit = globalThis.__csHistoryNetworkAudit;
              if (path.startsWith('/api/')) record(audit.allApiFetch, path);
              if (providerPaths.has(path) || path === '/api/memory/events') {
                record(audit.providerFetch, path);
              }
              return originalFetch(resource, init);
            };
            new PerformanceObserver((list) => {
              const audit = globalThis.__csHistoryNetworkAudit;
              for (const entry of list.getEntries()) {
                const path = pathFor(entry.name);
                if (providerPaths.has(path) || path === '/api/memory/events') {
                  audit.providerResources.push(path);
                }
              }
            }).observe({ type: 'resource', buffered: true });
            addEventListener('message', (event) => {
              if (event.origin !== viewerOrigin || event.data?.type !== 'CS_AGENT_SMOKE_VIEWER_STATE') return;
              globalThis.__csSmokeViewerState = event.data;
            });
          }
          if (location.origin === viewerOrigin) {
            const originalOpen = XMLHttpRequest.prototype.open;
            const originalSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
              try {
                this.__csManagedImportTransport =
                  new URL(String(url), location.href).pathname === '/_desktop/library/import';
              } catch { this.__csManagedImportTransport = false; }
              return originalOpen.call(this, method, url, ...rest);
            };
            XMLHttpRequest.prototype.send = function(body) {
              if (this.__csManagedImportTransport) {
                globalThis.webkit?.messageHandlers?.smokeTrace?.postMessage('MANAGED_IMPORT_TRANSPORT_START');
                this.addEventListener('loadend', () => {
                  globalThis.webkit?.messageHandlers?.smokeTrace?.postMessage('MANAGED_IMPORT_TRANSPORT_END');
                }, { once: true });
              }
              return originalSend.call(this, body);
            };
            let selectedPlayer = '';
            let reportedCanvasCount = 0;
            setInterval(() => {
              const text = document.body?.innerText ?? '';
              if (!selectedPlayer && text.includes('选择本场要分析的玩家')) {
                const buttons = [...document.querySelectorAll('button')]
                  .filter((button) => button.offsetParent !== null && button.innerText.trim().length > 0);
                const player = buttons.find((button) => !button.innerText.includes('选择'));
                if (player) {
                  selectedPlayer = player.innerText.trim();
                  player.click();
                }
              }
              const canvasCount = document.querySelectorAll('canvas').length;
              if (canvasCount > 0 && (canvasCount !== reportedCanvasCount || selectedPlayer)) {
                reportedCanvasCount = canvasCount;
                top.postMessage({
                  type: 'CS_AGENT_SMOKE_VIEWER_STATE',
                  selectedPlayer,
                  canvasCount,
                  route: location.pathname,
                }, appOrigin);
              }
            }, 250);
          }
        })();
        """
        configuration.userContentController.addUserScript(WKUserScript(
            source: auditScript,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        self.webView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: 1280, height: 800),
            configuration: configuration
        )
        super.init()
        configuration.userContentController.add(self, name: "smokeTrace")
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
                .expires: Date(timeIntervalSinceNow: 300),
                HTTPCookiePropertyKey("HttpOnly"): "TRUE",
                HTTPCookiePropertyKey("SameSite"): "Strict",
              ]) else {
            fail("WEBKIT_INPUT_INVALID")
            return
        }
        webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) { [weak self] in
            self?.webView.load(URLRequest(url: appURL, cachePolicy: .reloadIgnoringLocalCacheData))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + (input.demoPath == nil ? 40 : 210)) { [weak self] in
            self?.fail("WEBKIT_TIMEOUT")
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        switch phase {
        case .appInitial:
            inspectApp()
        case .appHistory:
            inspectHistoryApp()
        case .viewer:
            inspectViewer()
        }
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "smokeTrace",
              let value = message.body as? String,
              value == "MANAGED_IMPORT_TRANSPORT_START" || value == "MANAGED_IMPORT_TRANSPORT_END" else { return }
        trace(value)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("WEBKIT_NAVIGATION_FAILED")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail("WEBKIT_NAVIGATION_FAILED")
    }

    private func inspectApp() {
        guard !appInspectionStarted else { return }
        appInspectionStarted = true
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
                      iframe.contains("managedLibrary=1"),
                      (object["scriptCount"] as? Int ?? 0) > 0,
                      (object["stylesheetCount"] as? Int ?? 0) > 0 else {
                    self.fail("WEBKIT_APP_ASSERTION_FAILED")
                    return
                }
                self.appResult = object
                self.captureSnapshotIfRequested { [weak self] in
                    guard let self else { return }
                    if self.input.demoPath == nil { self.loadViewer() }
                    else { self.startManagedDemoJourney() }
                }
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

    private func startManagedDemoJourney() {
        demoDeadline = Date().addingTimeInterval(115)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            self?.requestManagedDemoPicker()
        }
    }

    private func requestManagedDemoPicker() {
        guard !pickerWasOpened else { return }
        if Date() >= demoDeadline {
            fail("WEBKIT_MANAGED_DEMO_PICKER_TIMEOUT")
            return
        }
        let script = """
        const button = document.querySelector('aside[aria-label="复盘历史"] button[title="导入 Demo"]');
        if (!button) return false;
        button.click();
        return true;
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] _ in
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                self?.requestManagedDemoPicker()
            }
        }
    }

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        guard !pickerWasOpened, let demoPath = input.demoPath else {
            completionHandler(nil)
            return
        }
        pickerWasOpened = true
        trace("MANAGED_IMPORT_START")
        completionHandler([URL(fileURLWithPath: demoPath)])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.pollManagedReviewReady()
        }
    }

    private func pollManagedReviewReady() {
        guard phase == .appInitial else { return }
        if Date() >= demoDeadline {
            fail("WEBKIT_MANAGED_REVIEW_TIMEOUT:\(managedStatus)")
            return
        }
        let script = """
        const text = document.body.innerText;
        const viewer = globalThis.__csSmokeViewerState ?? {};
        const rows = [...document.querySelectorAll('aside[aria-label="复盘历史"] button[class*="reviewButton"]')];
        const failure = [
          'Demo 解析失败',
          '资料库记录已标记为损坏',
          '复盘产物未能完整提交',
          '教学路线输入校验失败',
          '教学路线可用，但可恢复起点保存失败'
        ].find((message) => text.includes(message)) ?? '';
        return {
          ready: text.includes('教学路线与可恢复起点已就绪。'),
          failure,
          rowCount: rows.length,
          selectedPlayer: viewer.selectedPlayer ?? '',
          canvasCount: viewer.canvasCount ?? 0,
          route: viewer.route ?? '',
          activeReview: Boolean(document.querySelector('aside[aria-label="复盘历史"] button[aria-current="page"]')),
          coach: (document.querySelector('aside[aria-label="AI 教练"]')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 360),
          history: (document.querySelector('aside[aria-label="复盘历史"]')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 260),
          api: JSON.stringify(globalThis.__csHistoryNetworkAudit?.allApiFetch ?? {}),
        };
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            if case .success(let value) = result, let object = value as? [String: Any] {
                self.managedStatus = [
                    "ready=\(object["ready"] as? Bool ?? false)",
                    "rows=\(object["rowCount"] as? Int ?? 0)",
                    "active=\(object["activeReview"] as? Bool ?? false)",
                    "player=\(object["selectedPlayer"] as? String ?? "")",
                    "canvas=\(object["canvasCount"] as? Int ?? 0)",
                    "coach=\(object["coach"] as? String ?? "")",
                    "history=\(object["history"] as? String ?? "")",
                    "api=\(object["api"] as? String ?? "{}")",
                ].joined(separator: ";")
                if Date().timeIntervalSince(self.managedStatusTracedAt) >= 10 {
                    self.managedStatusTracedAt = Date()
                    self.trace("MANAGED_STATUS \(self.managedStatus)")
                }
                if let failure = object["failure"] as? String, !failure.isEmpty {
                    self.fail("WEBKIT_MANAGED_REVIEW_FAILED:\(failure)")
                    return
                }
                if !self.managedImportTraceEnded,
                   (object["canvasCount"] as? Int ?? 0) > 0,
                   let player = object["selectedPlayer"] as? String,
                   !player.isEmpty {
                    self.managedImportTraceEnded = true
                    self.trace("MANAGED_IMPORT_END")
                }
                if self.managedImportTraceEnded,
                   !self.managedReviewRowTraced,
                   (object["rowCount"] as? Int ?? 0) > 0 {
                    self.managedReviewRowTraced = true
                    self.trace("MANAGED_REVIEW_ROW")
                }
                if self.managedImportTraceEnded,
                   let coordinationPath = self.input.coordinationPath,
                   let marker = try? String(contentsOfFile: coordinationPath, encoding: .utf8) {
                    if marker == "READY",
                       (object["rowCount"] as? Int ?? 0) > 0,
                       (object["canvasCount"] as? Int ?? 0) > 0,
                       let player = object["selectedPlayer"] as? String,
                       !player.isEmpty {
                        self.demoResult = [
                            "parsed": true,
                            "selectedPlayer": player,
                            "canvasCount": object["canvasCount"] as? Int ?? 0,
                            "route": object["route"] as? String ?? "",
                            "managedImport": true,
                            "reviewPersisted": true,
                            "seededHistoryFixture": true,
                        ]
                        self.trace("HISTORY_FIXTURE_READY")
                        self.reloadForHistoryRestore()
                        return
                    }
                    if marker.hasPrefix("ERROR:") {
                        self.fail("WEBKIT_HISTORY_FIXTURE_FAILED:\(marker.dropFirst(6))")
                        return
                    }
                }
                if object["ready"] as? Bool == true,
                   (object["rowCount"] as? Int ?? 0) > 0,
                   (object["canvasCount"] as? Int ?? 0) > 0,
                   let player = object["selectedPlayer"] as? String,
                   !player.isEmpty {
                    self.demoResult = [
                        "parsed": true,
                        "selectedPlayer": player,
                        "canvasCount": object["canvasCount"] as? Int ?? 0,
                        "route": object["route"] as? String ?? "",
                        "managedImport": true,
                        "reviewPersisted": true,
                        "seededHistoryFixture": false,
                    ]
                    self.trace("MANAGED_REVIEW_READY")
                    self.reloadForHistoryRestore()
                    return
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.pollManagedReviewReady()
            }
        }
    }

    private func reloadForHistoryRestore() {
        phase = .appHistory
        historyInspectionStarted = false
        historyDeadline = Date().addingTimeInterval(65)
        guard let appURL = URL(string: "\(input.appOrigin)/desktop") else {
            fail("WEBKIT_INPUT_INVALID")
            return
        }
        webView.load(URLRequest(url: appURL, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    private func inspectHistoryApp() {
        guard !historyInspectionStarted else { return }
        historyInspectionStarted = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) { [weak self] in
            self?.pollHistoryRow()
        }
    }

    private func pollHistoryRow() {
        guard phase == .appHistory else { return }
        if Date() >= historyDeadline {
            fail("WEBKIT_HISTORY_LIST_TIMEOUT")
            return
        }
        let script = """
        const rows = [...document.querySelectorAll('aside[aria-label="复盘历史"] button[class*="reviewButton"]')];
        if (rows.length === 0 || typeof globalThis.__csHistoryResetNetworkAudit !== 'function') {
          return { clicked: false };
        }
        const row = rows[0];
        const title = row.querySelector('span')?.innerText.trim() ?? row.innerText.trim();
        const status = row.innerText.trim();
        globalThis.__csHistoryResetNetworkAudit();
        row.click();
        return { clicked: true, title, status };
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            if case .success(let value) = result,
               let object = value as? [String: Any],
               object["clicked"] as? Bool == true {
                self.historyResult = [
                    "clickedTitle": object["title"] as? String ?? "",
                    "clickedStatus": object["status"] as? String ?? "",
                ]
                self.trace("HISTORY_CLICKED")
                self.pollHistoryRestore()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                self?.pollHistoryRow()
            }
        }
    }

    private func pollHistoryRestore() {
        guard phase == .appHistory else { return }
        if Date() >= historyDeadline {
            fail("WEBKIT_HISTORY_RESTORE_TIMEOUT:\(historyStatus)")
            return
        }
        let script = """
        const text = document.body.innerText;
        const failure = [
          '无法安全恢复这条复盘',
          '保存的产物未通过身份或版本校验',
          'Agent 状态未恢复',
          '回放未能落到恢复位置',
          'Viewer 媒体暂不可用'
        ].find((message) => text.includes(message)) ?? '';
        return {
          restored: text.includes('复盘已恢复') &&
            (text.includes('已恢复到最近教学点，等待继续。') ||
              text.includes('已恢复到最近教学点；只使用保存的讲解产物。')),
          failure,
          progress: (document.querySelector('.cs2d-coach-badge')?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
          positionVisible: !text.includes('进度 —') && /进度\\s+第/u.test(text),
          activeReview: Boolean(document.querySelector('aside[aria-label="复盘历史"] button[aria-current="page"]')),
          coach: (document.querySelector('aside[aria-label="AI 教练"]')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 520),
          history: (document.querySelector('aside[aria-label="复盘历史"]')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 320),
          viewer: JSON.stringify(globalThis.__csSmokeViewerState ?? {}),
          api: JSON.stringify(globalThis.__csHistoryNetworkAudit?.allApiFetch ?? {}),
        };
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            if case .success(let value) = result, let object = value as? [String: Any] {
                self.historyStatus = [
                    "restored=\(object["restored"] as? Bool ?? false)",
                    "active=\(object["activeReview"] as? Bool ?? false)",
                    "progress=\(object["progress"] as? String ?? "")",
                    "coach=\(object["coach"] as? String ?? "")",
                    "history=\(object["history"] as? String ?? "")",
                    "viewer=\(object["viewer"] as? String ?? "{}")",
                    "api=\(object["api"] as? String ?? "{}")",
                ].joined(separator: ";")
                if Date().timeIntervalSince(self.historyStatusTracedAt) >= 10 {
                    self.historyStatusTracedAt = Date()
                    self.trace("HISTORY_STATUS \(self.historyStatus)")
                }
                if let failure = object["failure"] as? String, !failure.isEmpty {
                    self.fail("WEBKIT_HISTORY_RESTORE_FAILED:\(failure)")
                    return
                }
                if object["restored"] as? Bool == true,
                   object["activeReview"] as? Bool == true,
                   object["positionVisible"] as? Bool == true,
                   let progress = object["progress"] as? String,
                   progress.contains("/") {
                    guard !self.historyRestoreObserved else { return }
                    self.historyRestoreObserved = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { [weak self] in
                        self?.finishHistoryNetworkAudit(progress: progress)
                    }
                    return
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
                self?.pollHistoryRestore()
            }
        }
    }

    private func finishHistoryNetworkAudit(progress: String) {
        guard phase == .appHistory else { return }
        let script = """
        const providerPaths = new Set([
          '/api/coaching/direct',
          '/api/coaching/narrate',
          '/api/coaching/diagnose',
          '/api/coaching/policy',
          '/api/coaching/wrap-up',
          '/api/memory/events'
        ]);
        const audit = globalThis.__csHistoryNetworkAudit ?? { providerFetch: {}, allApiFetch: {}, providerResources: [] };
        const timed = performance.getEntriesByType('resource').flatMap((entry) => {
          try {
            const url = new URL(entry.name, location.href);
            return url.origin === location.origin && providerPaths.has(url.pathname) ? [url.pathname] : [];
          } catch { return []; }
        });
        const providerResources = [...new Set([...audit.providerResources, ...timed])];
        const providerCallCount = Object.values(audit.providerFetch).reduce((sum, value) => sum + value, 0);
        const allApiCallCount = Object.values(audit.allApiFetch).reduce((sum, value) => sum + value, 0);
        const paths = Object.keys(audit.allApiFetch);
        return {
          providerFetch: audit.providerFetch,
          allApiFetch: audit.allApiFetch,
          providerResources,
          providerCallCount,
          allApiCallCount,
          detailRequested: paths.some((path) => /^\\/api\\/review-history\\/[^/]+$/.test(path)),
          viewerSourceRequested: paths.some((path) => path.endsWith('/viewer-source')),
          agentRecoveryRequested: (audit.allApiFetch['/api/coaching/agent'] || 0) > 0,
          restoredText: document.body.innerText.includes('复盘已恢复') &&
            (document.body.innerText.includes('已恢复到最近教学点，等待继续。') ||
              document.body.innerText.includes('已恢复到最近教学点；只使用保存的讲解产物。')),
          positionVisible: !document.body.innerText.includes('进度 —') && /进度\\s+第/u.test(document.body.innerText),
        };
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { [weak self] result in
            guard let self else { return }
            guard case .success(let value) = result,
                  let audit = value as? [String: Any],
                  audit["providerCallCount"] as? Int == 0,
                  (audit["providerResources"] as? [Any] ?? []).isEmpty,
                  audit["detailRequested"] as? Bool == true,
                  audit["viewerSourceRequested"] as? Bool == true,
                  audit["restoredText"] as? Bool == true,
                  audit["positionVisible"] as? Bool == true else {
                self.fail("WEBKIT_HISTORY_NETWORK_AUDIT_FAILED")
                return
            }
            var history = self.historyResult ?? [:]
            history["restored"] = true
            history["progress"] = progress
            history["providerCallCount"] = audit["providerCallCount"] as? Int ?? -1
            history["providerResourceCount"] = (audit["providerResources"] as? [Any] ?? []).count
            history["allApiCallCount"] = audit["allApiCallCount"] as? Int ?? 0
            history["allApiFetch"] = audit["allApiFetch"] ?? [:]
            history["agentRecoveryRequested"] = audit["agentRecoveryRequested"] as? Bool ?? false
            history["positionVisible"] = true
            history["auditSource"] = "WKUserScript document-start fetch wrapper + PerformanceResourceTiming"
            self.historyResult = history
            self.trace("HISTORY_RESTORED")
            self.loadViewer()
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
                self.succeed(viewer: object)
            case .failure:
                self.fail("WEBKIT_VIEWER_SCRIPT_FAILED")
            }
        }
    }

    private func succeed(viewer: [String: Any]) {
        guard !finished, let appResult else { return }
        if input.demoPath != nil && (demoResult == nil || historyResult == nil) {
            fail("WEBKIT_MANAGED_JOURNEY_INCOMPLETE")
            return
        }
        finished = true
        var output: [String: Any] = ["ok": true, "app": appResult, "viewer": viewer]
        if let demoResult { output["demo"] = demoResult }
        if let historyResult { output["history"] = historyResult }
        if let data = try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]) {
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0a]))
        }
        NSApplication.shared.terminate(nil)
    }

    private func trace(_ value: String) {
        FileHandle.standardError.write(Data("webkit:trace \(value)\n".utf8))
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
