import { lastOfKind } from "./ledger.mjs";

/* Where this app is in the loop, as data.
 *
 * The loop IS the product, and a founder should be able to see it in one
 * glance rather than reconstruct it from three separate command outputs:
 *
 *   Checked  ->  Repaired  ->  Watched
 *      ^                          |
 *      +--- drift found again ----+
 *
 * Every stage answers the same three questions in the same order, because a
 * founder learns the shape once and then reads every stage for free:
 *   what happened, what it proved, what it hands to the next stage.
 *
 * "done" here always means EXECUTED and observed. A stage that was skipped, or
 * that could not run, is never drawn as done — the picture is evidence, not
 * decoration, and a green line nobody earned is the most expensive lie this
 * page could tell.
 */

export const STAGES = ["checked", "repaired", "watched"];

export function buildJourney({ detection = null, lifecycle = null, sandbox = null, ledger = [], sweep = null }) {
  const check = lastOfKind(ledger, "check");
  const fix = lastOfKind(ledger, "fix");
  const lastSweep = sweep || lastOfKind(ledger, "sweep");

  const ranLive = Boolean(lifecycle || sandbox || check?.lifecycleGrade || check?.sandboxGrade);
  const grade = sandbox?.grade?.letter || lifecycle?.grade?.letter || check?.grade || null;
  const passing = grade === "A";

  /* Stage 1: checked. Reading code is real work and counts as started, but
     only an executed run counts as proof, so the two are never conflated. */
  const checked = {
    id: "checked",
    label: "Checked",
    state: ranLive ? "done" : detection || check ? "partial" : "todo",
    what: ranLive
      ? "A pretend customer paid, cancelled, failed a card and was refunded, against your running app."
      : detection || check
        ? "Your code was read. Nothing has been executed yet."
        : "Not run yet.",
    proved: ranLive
      ? (grade ? `Grade ${grade}.` : "Executed.")
      : "Reading code shows what your app is supposed to do, not what it does.",
    handsOn: ranLive
      ? (passing
        /* "Nothing to repair" next to a completed repair reads as a
           contradiction, so a repair that already happened is acknowledged. */
        ? (fix ? "Nothing left to repair." : "Nothing to repair.")
        : "The exact scenarios that failed, which is what the repair is built from.")
      : "Nothing yet. The live test is what produces evidence.",
  };

  /* Stage 2: repaired. A repair only counts once something independently
     agreed it worked; "we wrote files" is not a repair. */
  const repairedAndProven = Boolean(fix) && passing && ranLive;
  const repairedNotProven = Boolean(fix) && !passing;
  const repaired = {
    id: "repaired",
    label: "Repaired",
    /* An app that passed with nothing to repair has not SKIPPED this step, it
       did not need it. Drawing that as "not yet" makes a healthy app look
       unfinished and sends the founder looking for work that does not exist. */
    state: repairedAndProven ? "done"
      : repairedNotProven ? "failed"
      : fix ? "partial"
      : (ranLive && !passing) ? "next"
      : (ranLive && passing) ? "not_needed"
      : "todo",
    what: fix
      ? `Akeso wrote ${fix.files?.length || 0} files: the corrected webhook handler, one entitlement function, and the backstop.`
      : ranLive && !passing
        ? "Not done yet. This is what fixes what the check found."
        : ranLive
          ? "Skipped, because the check found nothing to repair."
          : "Nothing to repair yet.",
    proved: repairedAndProven
      ? "The same test was run again afterwards and passed."
      : repairedNotProven
        ? "The test still fails, so Akeso does not call this repaired."
        : fix ? "Applied, but not yet re-tested." : "",
    handsOn: repairedAndProven
      ? "Correct handling from now on. It does not fix accounts that already drifted."
      : "",
  };

  /* Stage 3: watched. Correct code and correct state are different claims.
     A sweep that matched no accounts at all ran fine and proved nothing: the
     ids on the two sides did not line up. Drawing that as done would tell a
     founder they are covered when nothing was actually compared. */
  const sweptSomething = Boolean(lastSweep) && !lastSweep.couldNotRun && (lastSweep.comparison?.counts?.matched ?? 0) > 0;
  const sweptNothing = Boolean(lastSweep) && !lastSweep.couldNotRun && !sweptSomething;
  const watched = {
    id: "watched",
    label: "Watched",
    state: sweptSomething ? "done" : lastSweep ? "failed" : (passing || repairedAndProven) ? "next" : "todo",
    what: sweptSomething
      ? `Stripe and your app were compared across ${lastSweep.comparison.counts.matched} matched accounts.`
      : sweptNothing
        ? "The last run compared nothing: no Stripe subscription matched any account your app reported."
        : lastSweep
          ? "The last sweep could not run."
          : "Not started. This compares today's real customers against Stripe.",
    proved: sweptSomething
      ? (lastSweep.comparison?.clean ? "Everyone's access matches what they pay." : "Accounts were found that do not match.")
      : sweptNothing
        ? "Nothing was learned, because the account ids on the two sides do not line up."
        : lastSweep ? "Nothing about your app was learned from that run." : "",
    handsOn: sweptSomething && !lastSweep.comparison?.clean
      ? "The list of accounts to put right."
      : sweptNothing
        ? "Nothing, until Stripe and your app agree on what an account is called."
        : "",
  };

  const stages = [checked, repaired, watched];
  const current = stages.find((stage) => stage.state === "next")
    || [...stages].reverse().find((stage) => stage.state === "done" || stage.state === "failed" || stage.state === "partial")
    || checked;

  return { stages, currentId: current.id, grade, ranLive, passing };
}

/* The strip, as HTML. Deliberately CSS-only: an SVG that needs measuring, or a
   diagram that needs a library, is a diagram that breaks in someone's browser
   and takes the trust story with it. */
export function renderJourney(journey, { escape }) {
  const dots = journey.stages.map((stage, index) => {
    const last = index === journey.stages.length - 1;
    /* The connector belongs to the stage BEFORE it and is only solid when that
       stage actually completed, so the line itself carries meaning. */
    const connector = last ? "" : `<div class="jline ${stage.state === "done" || stage.state === "not_needed" ? "jline-done" : ""}"></div>`;
    return `<div class="jstage j-${stage.state}${stage.id === journey.currentId ? " j-current" : ""}">
      <div class="jmark"><span class="jdot"></span>${connector}</div>
      <div class="jlabel">${escape(stage.label)}</div>
      <div class="jstate">${escape(stateWord(stage.state))}</div>
    </div>`;
  }).join("");

  const detail = journey.stages.map((stage) => `<div class="jrow j-${stage.state}">
      <div class="jrowhead">
        <span class="jrowdot"></span>
        <span class="jrowlabel">${escape(stage.label)}</span>
      </div>
      <div class="jrowbody">
        <p class="jwhat">${escape(stage.what)}</p>
        ${stage.proved ? `<p class="jproved">${escape(stage.proved)}</p>` : ""}
        ${stage.handsOn ? `<p class="jhands"><span class="jhandslabel">Hands to the next step</span>${escape(stage.handsOn)}</p>` : ""}
      </div>
    </div>`).join("");

  return { strip: `<div class="journey">${dots}</div>`, detail: `<div class="jdetail">${detail}</div>` };
}

const stateWord = (state) => ({
  done: "done",
  partial: "started",
  failed: "did not hold",
  next: "next",
  todo: "not yet",
  not_needed: "not needed",
}[state] || state);

/* The same picture, for the terminal.
 *
 * A founder should meet one shape and then recognise it everywhere. Printing a
 * different mental model in the terminal than on the page would mean learning
 * the product twice, so both are drawn from the same buildJourney() result.
 *
 *     [x] Checked ---- [x] Repaired ---- ( ) Watched
 *      found the problem   wrote the fix     you are here
 */
export function printJourney(journey) {
  const MARK = { done: "[x]", partial: "[~]", failed: "[!]", next: "( )", todo: "( )", not_needed: "[-]" };

  const cells = journey.stages.map((stage) => {
    const label = `${MARK[stage.state] || "( )"} ${stage.label}`;
    const under = stage.id === journey.currentId ? "you are here" : shortState(stage);
    return { label, under, width: Math.max(label.length, under.length) };
  });

  /* The connector is solid only where the stage before it finished, so the
     line itself carries the same meaning it does on the page. */
  const top = cells.map((cell, i) => {
    const pad = " ".repeat(cell.width - cell.label.length);
    const joint = i === cells.length - 1 ? "" : (["done", "not_needed"].includes(journey.stages[i].state) ? " ---- " : " . . . ");
    return `${cell.label}${pad}${joint}`;
  }).join("");

  const bottom = cells.map((cell, i) => {
    const pad = " ".repeat(cell.width - cell.under.length);
    const joint = i === cells.length - 1 ? "" : " ".repeat(6);
    return `${cell.under}${pad}${joint}`;
  }).join("");

  console.log(`\n${top}`);
  console.log(bottom);
}

const shortState = (stage) => ({
  done: "done",
  partial: "started",
  failed: "did not hold",
  next: "next",
  todo: "not yet",
  not_needed: "not needed",
}[stage.state] || "");

export const JOURNEY_CSS = `
  .journey { display:flex; margin:0 0 6px; }
  .jstage { flex:1; min-width:0; }
  .jmark { position:relative; height:11px; display:flex; align-items:center; }
  .jdot { width:11px; height:11px; border-radius:50%; flex:none; border:1.5px solid var(--ink3); background:var(--card); box-sizing:border-box; }
  .jline { flex:1; height:1.5px; background:var(--line); }
  .jline-done { background:var(--ok); }
  .j-done .jdot { background:var(--ok); border-color:var(--ok); }
  .j-failed .jdot { background:var(--bad); border-color:var(--bad); }
  .j-partial .jdot { border-color:var(--warn); }
  .j-next .jdot { border-color:var(--ink); border-style:dashed; }
  .j-todo .jdot { border-color:var(--line); }
  .j-not_needed .jdot { background:var(--line); border-color:var(--line); }
  .jlabel { font-size:13.5px; font-weight:500; margin-top:11px; }
  .j-todo .jlabel { color:var(--ink3); font-weight:400; }
  .jstate { font-size:12px; color:var(--ink3); margin-top:1px; }
  .j-done .jstate { color:var(--ok); }
  .j-failed .jstate { color:var(--bad); }
  .j-current .jstate { color:var(--ink); }

  .jdetail { margin-top:30px; border-top:1px solid var(--line); }
  .jrow { display:flex; gap:14px; padding:16px 0; border-bottom:1px solid var(--line); }
  .jrowhead { flex:none; width:104px; display:flex; align-items:baseline; gap:8px; }
  .jrowdot { width:7px; height:7px; border-radius:50%; background:var(--line); flex:none; }
  .jrow.j-done .jrowdot { background:var(--ok); }
  .jrow.j-failed .jrowdot { background:var(--bad); }
  .jrow.j-partial .jrowdot { background:var(--warn); }
  .jrow.j-not_needed .jrowdot { background:var(--line); }
  .jrowlabel { font-size:13.5px; font-weight:500; }
  .jrow.j-todo .jrowlabel { color:var(--ink3); font-weight:400; }
  .jrowbody { flex:1; min-width:0; }
  .jwhat { margin:0; font-size:14px; }
  .jrow.j-todo .jwhat { color:var(--ink3); }
  .jproved { margin:5px 0 0; font-size:13.5px; color:var(--ink2); }
  .jhands { margin:9px 0 0; font-size:13px; color:var(--ink3); }
  .jhandslabel { display:block; font-size:10.5px; letter-spacing:.07em; text-transform:uppercase; margin-bottom:2px; }
  @media (max-width:520px) {
    .jrow { display:block; }
    .jrowhead { width:auto; margin-bottom:7px; }
  }
`;
