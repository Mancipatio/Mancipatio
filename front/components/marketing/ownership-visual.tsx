"use client";

import { useId, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import styles from "./ownership-visual.module.css";

const steps = [
  { title: "Token", description: "A right to acquire a company share." },
  { title: "Convert", description: "KYC check. Tokens locked in escrow." },
  { title: "Register", description: "Ownership entered in the official register, off-chain." },
  { title: "Burn", description: "Tokens burn after registration. You are the registered owner." },
] as const;

function subscribeToMotion(onChange: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const reducedMotionSnapshot = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// A complete, still diagram is also the server-rendered / no-JavaScript view.
const serverMotionSnapshot = () => true;

/** A conceptual conversion process, never a representation of an account or transaction. */
export function OwnershipVisual() {
  const titleId = useId();
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [manual, setManual] = useState(false);
  const reducedMotion = useSyncExternalStore(subscribeToMotion, reducedMotionSnapshot, serverMotionSnapshot);

  function selectStep(index: number) {
    setStep(index);
    setPlaying(false);
    setManual(true);
  }

  function navigateSteps(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
    const current = buttons.indexOf(event.target as HTMLButtonElement);
    if (current === -1) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? steps.length - 1
      : (current + (event.key === "ArrowRight" ? 1 : -1) + steps.length) % steps.length;
    selectStep(next);
    buttons[next].focus();
  }

  return (
    <div className={styles.poster} role="group" aria-labelledby={titleId}
      data-step={step} data-playing={playing && !reducedMotion} data-manual={manual} data-static={reducedMotion}>
      <div className={styles.heading}>
        <span id={titleId}>The ownership path</span>
        {reducedMotion ? <span className={styles.motionOff}>Motion off</span> : (
          <button type="button" className={styles.playback}
            aria-label={playing ? "Pause ownership animation" : "Play ownership animation"}
            onClick={() => { setPlaying(!playing); setManual(false); }}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              {playing ? <path d="M5 3v10M11 3v10" fill="none" stroke="currentColor" strokeWidth="2" />
                : <path d="m5 2 9 6-9 6Z" fill="currentColor" />}
            </svg>
            {playing ? "Pause" : "Play"}
          </button>
        )}
      </div>

      <div className={styles.scene} aria-hidden="true">
        <svg viewBox="0 0 480 280" fill="none" focusable="false">
          <path className={styles.track} d="M140 72h196M380 143v17M336 208H145" />
          <path className={styles.arrow} d="m329 67 7 5-7 5m46 76 5 7 5-7m-233 50-7 5 7 5" />
          <path className={styles.tokenPath} d="M140 72h196" pathLength="1" />
          <path className={styles.registerPath} d="M380 143v17" pathLength="1" />
          <path className={styles.ownerPath} d="M336 208H145" pathLength="1" />
          <circle className={styles.origin} cx="100" cy="72" r="39" />
          <path className={styles.originMark} d="m89 72 11-7 11 7-11 7Z" />
          <g className={styles.escrow}>
            <rect x="345" y="39" width="70" height="68" rx="15" />
            <path className={styles.lock} d="M367 39V28a13 13 0 0 1 26 0v11" />
          </g>
          <g className={styles.kycCheck}>
            <circle cx="424" cy="43" r="11" /><path d="m419 43 3 3 6-6" />
          </g>
          <g className={styles.registry}>
            <path d="M350 171h43l17 17v55h-60Z" /><path d="M393 171v17h17" />
            <path className={styles.registerRules} d="M362 201h34m-34 12h34m-34 12h22" />
            <path className={styles.registerEntry} d="M362 201h34m-34 12h34m-34 12h22" pathLength="1" />
          </g>
          <g className={styles.registrationSeal}>
            <circle cx="410" cy="232" r="13" /><path d="m404 232 4 4 8-8" />
          </g>
          <g className={styles.owner}>
            <circle cx="100" cy="208" r="35" /><circle className={styles.ownerHead} cx="100" cy="199" r="8" />
            <path className={styles.ownerBody} d="M84 223v-2c0-8 7-13 16-13s16 5 16 13v2" />
          </g>
          <g className={styles.ownerCheck}>
            <circle cx="127" cy="231" r="12" /><path d="m122 231 3 3 7-7" pathLength="1" />
          </g>
          <g className={styles.tokenTravel}>
            <g className={styles.token}>
              <path d="m-12-23 24 0 11 11v24L12 23h-24l-11-11v-24Z" />
              <path className={styles.tokenInset} d="m-9-17 18 0 8 8V9l-8 8H-9l-8-8V-9Z" />
              <path className={styles.tokenMark} d="M-8 7V-7l8 8 8-8V7" />
            </g>
          </g>
          <g className={styles.burn}>
            <path d="M380 44v-7m20 15 5-5m3 25h7m-15 20 5 5m-25 3v7m-20-15-5 5m-3-25h-7m15-20-5-5" />
          </g>
        </svg>
        <span className={`${styles.sceneLabel} ${styles.tokenLabel}`}>Right to a share</span>
        <span className={`${styles.sceneLabel} ${styles.escrowLabel}`}>KYC + escrow</span>
        <span className={`${styles.sceneLabel} ${styles.registerLabel}`}>Official register <small>Off-chain</small></span>
        <span className={`${styles.sceneLabel} ${styles.ownerLabel}`}>Registered owner</span>
      </div>

      <div className={styles.steps} role="group" aria-label="Ownership process steps" onKeyDown={navigateSteps}>
        {steps.map((item, index) => (
          <button key={item.title} type="button" className={styles.step} aria-pressed={step === index}
            aria-label={`Show step ${index + 1}: ${item.title}. ${item.description}`} onClick={() => selectStep(index)}>
            <span className={styles.stepTitle}><span>0{index + 1}</span>{item.title}</span>
            <span className={styles.stepDescription}>{item.description}</span>
            {step === index && <span className={styles.progress} aria-hidden="true"><span key={`${step}-${manual}`}
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget && playing && !reducedMotion) setStep((current) => (current + 1) % steps.length);
              }}
            /></span>}
          </button>
        ))}
      </div>
      <p className={styles.caption}>Illustrated conversion process</p>
    </div>
  );
}
