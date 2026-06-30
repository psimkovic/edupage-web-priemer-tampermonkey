// ==UserScript==
// @name         EduPage – Vážený priemer známok po predmetoch (SK)
// @namespace    https://github.com/psimkovic/edupage-web-priemer-tampermonkey
// @version      1.1
// @description  Zobrazí priemer známok na WEB stránke edupage Známky. Na mobilných zariadeniach sa priemer zobrazuje automaticky.
// @author       Peter
// @match        https://*.edupage.org/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // ---- Ako sa priemer počíta ---------------------------------------------
    // Každý predmet (tr.predmetRow) má jeden alebo viacero riadkov
    // (tr.udalostRow) zdiaľajúcich rovnaký data-predmetid. Použije sa LEN
    // riadky udalosti – známky, ktoré sú na riadku s predmetom sú ignorované
    // shown inline on the subject row are ignored.
    //
    // Riadok udalosti obsahuje jednu alebo viacero známok, ktoré môžu mať
    // váhu udalosti, označené ako "Váha udalosti: N×" = váha. Ak tam váha nie
    // je -> váha 1. Váha 0 -> známky sú ignorované.
    //
    //   primer = Σ(známka × váha) / Σ(váha)
    //
    // Získavanie známok:
    //   * normálne známky sú v span.znZnamka  (napr. "1", "2", "1-", "2+")
    //   * normálne známky obsahujúce "%" sú ignorované
    //   * vyhodnotené známky z testov sú v span.znamkaVyhodnotenie
    //     (napr. "15 / 18 = 83.3% → 2") – číslo za "→" je známka
    //   * +/- okolo známky je ignorované; berú sa len známky 1–5
    //
    // Nižšia známka je lepšia (štandardná slovenská stupnica 1-5).
    // ----------------------------------------------------------------------

    const BADGE_CLASS = 'gpa-weighted-badge';
    let debounceTimer = null;
    let observer = null;

    // Parse the weight from an event row. Looks for "<number>×" inside the
    // small weight <div>; returns 1 when no weight is present.
    function parseWeight(row) {
        const cell = row.querySelector('td.fixedCell') || row.querySelector('td');
        if (!cell) return 1;
        const div = cell.querySelector('div');
        const text = (div ? div.textContent : cell.textContent) || '';
        const m = text.match(/([\d]+(?:[.,]\d+)?)\s*[×x]/i);
        if (m) {
            const w = parseFloat(m[1].replace(',', '.'));
            if (!isNaN(w) && w >= 0) return w;
        }
        return 1;
    }

    // Turn a grade string into a number 1–5, or null if not a valid grade.
    // Handles "1", "2", "1-", "2+", and evaluation text like
    // "15 / 18 = 83.3% → 2" (takes the part after the last arrow).
    function gradeValueFromText(text) {
        if (text == null) return null;
        let t = String(text).trim();
        const parts = t.split(/→|->/);          // arrow → take what follows
        if (parts.length > 1) t = parts[parts.length - 1];
        const m = t.match(/(\d+)/);              // leading integer, drop +/-
        if (!m) return null;
        const v = parseInt(m[1], 10);
        return (v >= 1 && v <= 5) ? v : null;    // accept only 1–5
    }

    // Collect grade values from a single event row.
    function collectGrades(row) {
        const grades = [];

        // Evaluation grades: "15 / 18 = 83.3% → 2"
        row.querySelectorAll('span.znamkaVyhodnotenie').forEach(span => {
            const v = gradeValueFromText(span.textContent);
            if (v != null) grades.push(v);
        });

        // Normal grades. Skip ones nested inside an evaluation span (already
        // handled above) and skip any grade that contains a percent.
        row.querySelectorAll('span.znZnamka').forEach(span => {
            if (span.closest('span.znamkaVyhodnotenie')) return;
            const raw = span.textContent || '';
            if (raw.indexOf('%') !== -1) return;
            const v = gradeValueFromText(raw);
            if (v != null) grades.push(v);
        });

        return grades;
    }

    // Background colour for the badge based on the average (1 best, 5 worst).
    function colorFor(avg) {
        if (avg <= 1.5) return '#1e9e4a';   // green
        if (avg <= 2.5) return '#7cb342';   // lime
        if (avg <= 3.5) return '#f0a000';   // amber
        if (avg <= 4.5) return '#e8590c';   // orange-red
        return '#d32f2f';                   // red
    }

    function makeBadge() {
        const b = document.createElement('span');
        b.className = BADGE_CLASS;
        b.style.cssText =
            'display:inline-block;vertical-align:middle;margin-left:8px;' +
            'padding:1px 7px;border-radius:10px;font-size:11px;font-weight:bold;' +
            'color:#fff;line-height:1.5;white-space:nowrap;';
        return b;
    }

    function computeAverages() {
        const subjectRows = document.querySelectorAll('tr.predmetRow[data-predmetid]');

        subjectRows.forEach(prow => {
            const pid = prow.getAttribute('data-predmetid');
            if (!pid) return;

            // CSS.escape guards against unusual ids; fall back gracefully.
            const sel = (window.CSS && CSS.escape) ? CSS.escape(pid) : pid;
            const eventRows = document.querySelectorAll(
                `tr.udalostRow[data-predmetid="${sel}"]`
            );

            let weightedSum = 0;
            let weightTotal = 0;
            let gradeCount = 0;

            // Only event (udalost) rows are used; grades on the subject row
            // itself are ignored.
            eventRows.forEach(er => {
                const w = parseWeight(er);
                collectGrades(er).forEach(g => {
                    weightedSum += g * w;
                    weightTotal += w;
                    gradeCount++;
                });
            });

            const cell = prow.querySelector('td.fixedCell') || prow.querySelector('td');
            if (!cell) return;
            let badge = cell.querySelector('.' + BADGE_CLASS);

            // No usable grades (or all weights are 0) -> remove any stale badge.
            if (gradeCount === 0 || weightTotal <= 0) {
                if (badge) badge.remove();
                return;
            }

            const avg = weightedSum / weightTotal;
            if (!badge) {
                badge = makeBadge();
                cell.appendChild(badge);
            }
            badge.style.background = colorFor(avg);
            badge.textContent = '⌀ ' + avg.toFixed(2);
            badge.title =
                'Weighted average from ' + gradeCount + ' grade(s)\n' +
                'Σ(grade×weight)=' + weightedSum.toFixed(2) +
                '  /  Σ(weight)=' + weightTotal.toFixed(2);
        });
    }

    // Run with the observer briefly disconnected so our own DOM edits don't
    // retrigger it in a loop.
    function run() {
        if (observer) observer.disconnect();
        try {
            computeAverages();
        } catch (e) {
            console.error('[EduPage GPA] error:', e);
        } finally {
            if (observer) observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    function schedule() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(run, 300);
    }

    function init() {
        observer = new MutationObserver(schedule);
        observer.observe(document.body, { childList: true, subtree: true });
        run();
        // Safety net for late AJAX renders.
        setTimeout(run, 1500);
        setTimeout(run, 4000);
    }

    if (document.body) {
        init();
    } else {
        window.addEventListener('DOMContentLoaded', init);
    }
})();