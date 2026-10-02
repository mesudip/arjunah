/**
 * अर्जुनः hosted-panel wording and choices (SPEC 15.1 to 15.3).
 *
 * Pure functions the content script uses to fill the consent sheet and the
 * panel for each mode, kept apart from the DOM so the exact sentences and the
 * picker's default can be tested without a browser. It is a classic script
 * loaded beside content.js; it touches no extension API, the network, or the
 * page.
 */
var ArjunahHosted = (function () {
  "use strict";

  // SPEC 15.3 fixes this sentence for `composer: "server"`.
  const SERVER_LINE =
    "This site's server writes the prompts and sends them, including the results of tools it runs, to the model you choose. अर्जुनः cannot show these prompts.";
  const PAGE_LINE =
    "This site's page writes the prompts and sends them, including the results of tools it runs, to the model you choose. अर्जुनः cannot show these prompts.";

  const who = (composer) =>
    composer === "server" ? "this site's server" : "this site's page";

  // Characters that reorder or hide the text drawn around them: directional
  // marks, embeddings, overrides and isolates, zero-width space, word joiner
  // and invisible operators, and the byte order mark. ZWJ and ZWNJ stay, since
  // Indic scripts need them.
  const INVISIBLE =
    /[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

  function bounded(text, max) {
    const points = [...text];
    return points.length > max ? `${points.slice(0, max - 1).join("")}…` : text;
  }

  /**
   * Text a site wrote, as one line of the extension's own UI: no invisible
   * reordering characters, no control characters or line breaks (which would
   * let it draw lines that look like the extension's), at most `max` code
   * points.
   */
  function plainLine(value, max = 2000) {
    const text = String(value ?? "")
      .replace(INVISIBLE, "")
      .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return bounded(text, max);
  }

  /** Like `plainLine`, but keeps line breaks, for a block shown as a block. */
  function plainText(value, max = 100000) {
    const text = String(value ?? "")
      .replace(INVISIBLE, "")
      .replace(/\r\n?|[\u2028\u2029]/g, "\n")
      .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
    return bounded(text, max);
  }

  /**
   * The statements the consent sheet adds for one request (SPEC 15.3):
   *
   * - `mode` is `"page"` for a page's own `enable()`, `"hosted"` for mode 1
   *   (the extension composes), and `"loop"` for modes 2 and 3;
   * - `composer` is the request's or the loop's (`"server"` / `"webapp"`);
   * - `siteModel` is the site's own model entry when it answers, else null;
   * - `approvals` lists the tools that ask the visitor before they run;
   * - `loopInputs` says a loop declared that it asks for values.
   *
   * A page's `"webapp"` request adds nothing, so today's level 1 and 2 wording
   * stands for it.
   */
  function consentLines({
    mode = "page",
    composer = "webapp",
    siteModel = null,
    approvals = [],
    loopInputs = false,
  } = {}) {
    const lines = [];
    const name = siteModel
      ? plainLine(siteModel.displayName ?? siteModel.id ?? "", 80)
      : "";
    if (mode === "page") {
      if (composer === "server") lines.push(SERVER_LINE);
    } else if (mode === "loop") {
      if (siteModel)
        lines.push(
          `${capitalized(who(composer))} runs the conversation and answers it with its own model (${name}). Your AI is not used for these replies.`,
          `${capitalized(who(composer))} sees everything you type in this panel.`,
        );
      else
        lines.push(
          composer === "server" ? SERVER_LINE : PAGE_LINE,
          `${capitalized(who(composer))} sees everything you type in this panel and every reply your model gives. Page context is not shared in this mode.`,
        );
    }
    // A loop's prompts sit inside the extension's panel, so consent says who
    // writes them before the first one appears (SPEC 15.1).
    if (mode === "loop") {
      lines.push(
        `${capitalized(who(composer))} can ask you, in this panel, to approve an action before one of its tools runs. Each prompt names this site as the one asking.`,
      );
      if (loopInputs)
        lines.push(
          `${capitalized(who(composer))} can also ask you, in this panel, for values its tools need, masked ones included. What you enter goes to this site and not to the model; अर्जुनः never asks for your provider credentials there.`,
        );
    } else if (mode === "hosted" && siteModel)
      lines.push(
        `This site's own model (${name}) answers this assistant. Your AI is not used for these replies, and the site receives what the assistant sends it: your messages, any page context you share, and tool results.`,
      );
    const asking = approvals
      .filter((item) => typeof item === "string")
      .map((item) => plainLine(item, 200));
    if (asking.length)
      lines.push(
        `${asking.length === 1 ? "This tool asks" : "These tools ask"} you before ${asking.length === 1 ? "it runs" : "they run"}: ${asking.slice(0, 32).join(", ")}.`,
      );
    return lines;
  }

  /**
   * The persistent line a panel driven by another composer carries (SPEC
   * 15.3, "Shown in"), so extension chrome never implies extension authorship.
   */
  function panelLine(composer, siteModel = false) {
    return siteModel
      ? `This conversation is run and answered by ${who(composer)}.`
      : `This conversation is run by ${who(composer)}. अर्जुनः shows it and answers with the model you choose.`;
  }

  function capitalized(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  /** The site's models as picker entries, grouped under the site's name. */
  function siteModelEntries(manifest) {
    const list = manifest?.models?.list;
    if (!Array.isArray(list)) return [];
    return list.map((entry) => ({
      id: entry.id,
      displayName: entry.displayName,
      providerId: "site",
      providerName: plainLine(manifest.name ?? "This site", 60),
      capabilities: { ...entry.capabilities },
      contextWindow: entry.contextWindow ?? null,
      reasoningLevels: [...(entry.reasoningLevels ?? [])],
    }));
  }

  /** A site model as `bridge.model` announces it (SPEC 15.2): kind "site". */
  function bridgeEntry(entry) {
    return {
      id: entry.id,
      displayName: entry.displayName,
      capabilities: { ...entry.capabilities },
      contextWindow: entry.contextWindow ?? null,
      reasoningLevels: [...(entry.reasoningLevels ?? [])],
      kind: "site",
    };
  }

  /**
   * The model the picker starts on (SPEC 15.2): a choice not yet stored, else
   * the visitor's stored choice of a site model, else the visitor's own site
   * model, and only when the visitor has none, the site's first model.
   */
  function pickerSelection({
    pending = null,
    siteChoice = null,
    visitorModel = null,
    siteModels = [],
    visitorModels = [],
  } = {}) {
    const site = new Set(siteModels.map((entry) => entry.id));
    const visitor = new Set(visitorModels.map((entry) => entry.id));
    if (pending && (site.has(pending) || visitor.has(pending))) return pending;
    if (siteChoice && site.has(siteChoice)) return siteChoice;
    if (visitorModel) return visitorModel;
    return siteModels[0]?.id ?? null;
  }

  return {
    SERVER_LINE,
    PAGE_LINE,
    consentLines,
    panelLine,
    plainLine,
    plainText,
    siteModelEntries,
    bridgeEntry,
    pickerSelection,
  };
})();
