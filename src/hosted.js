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

  /**
   * The statements the consent sheet adds for one request (SPEC 15.3):
   *
   * - `mode` is `"page"` for a page's own `enable()`, `"hosted"` for mode 1
   *   (the extension composes), and `"loop"` for modes 2 and 3;
   * - `composer` is the request's or the loop's (`"server"` / `"webapp"`);
   * - `siteModel` is the site's own model entry when it answers, else null;
   * - `approvals` lists the tools that ask the visitor before they run.
   *
   * A page's `"webapp"` request adds nothing, so today's level 1 and 2 wording
   * stands for it.
   */
  function consentLines({
    mode = "page",
    composer = "webapp",
    siteModel = null,
    approvals = [],
  } = {}) {
    const lines = [];
    const name = siteModel
      ? String(siteModel.displayName ?? siteModel.id ?? "").slice(0, 80)
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
    } else if (mode === "hosted" && siteModel)
      lines.push(
        `This site's own model (${name}) answers this assistant. Your AI is not used for these replies, and the site receives what the assistant sends it: your messages, any page context you share, and tool results.`,
      );
    const asking = approvals.filter((item) => typeof item === "string");
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
      providerName: String(manifest.name ?? "This site").slice(0, 60),
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
    siteModelEntries,
    bridgeEntry,
    pickerSelection,
  };
})();
