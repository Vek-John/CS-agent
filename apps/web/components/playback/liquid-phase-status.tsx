"use client";

import { Liquid } from "liquid-gooey";
import styles from "./liquid-phase-status.module.css";

export type LiquidPhase = "BOOTING" | "WAITING_FOR_DEMO" | "READY" | "ERROR";

const PHASE_STYLE: Record<LiquidPhase, { firstX: number; secondX: number; fill: string }> = {
  BOOTING: { firstX: 0, secondX: 0, fill: "var(--orange)" },
  WAITING_FOR_DEMO: { firstX: 1, secondX: -1, fill: "var(--orange)" },
  READY: { firstX: 4, secondX: -4, fill: "var(--green)" },
  ERROR: { firstX: 3, secondX: -3, fill: "var(--red)" },
};

export function LiquidPhaseStatus({ phase, label }: { phase: LiquidPhase; label: string }) {
  const presentation = PHASE_STYLE[phase];

  return (
    <div className={styles.status} data-phase={phase} role="status" aria-live="polite">
      <Liquid
        aria-hidden="true"
        className={styles.liquid}
        blur={4.5}
        contrast={20}
        fill={presentation.fill}
        filterPadding={10}
        shadow="0 0 9px color-mix(in srgb, currentColor 45%, transparent)"
      >
        <Liquid.Item
          x={presentation.firstX}
          transition={{ duration: 180, ease: "cubic-bezier(0.23, 1, 0.32, 1)" }}
          radius={999}
        >
          <span className={styles.dot} />
        </Liquid.Item>
        <Liquid.Item
          x={presentation.secondX}
          transition={{ duration: 180, ease: "cubic-bezier(0.23, 1, 0.32, 1)" }}
          delay={20}
          radius={999}
        >
          <span className={styles.dot} />
        </Liquid.Item>
      </Liquid>
      <span className={styles.label}>{label}</span>
    </div>
  );
}
