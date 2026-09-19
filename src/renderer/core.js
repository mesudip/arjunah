/**
 * अर्जुनः renderer core (SPEC 8.1).
 *
 * This is the chat surface itself: transcript, activity feed, transcript cards,
 * tool progress, the thread panel and the composer. It is deliberately free of
 * wallet concepts. The extension wraps it with consent, provider pickers and
 * usage (wallet mode); the standalone package wraps it with a backend client
 * (SPEC 14). Both drive it through the same `host` callbacks and the same
 * normalized event vocabulary, so the conversation looks and behaves the same
 * whether or not the extension is installed.
 *
 * It is written as a classic script so the extension can load it beside the
 * content script without a bundler; the npm package appends an ESM footer to
 * this exact file. Nothing here touches `innerHTML`, the network, or storage.
 */
var ArjunahRenderer = (function () {
  "use strict";

  const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  const LIMITS = {
    historyMessages: 40,
    progressChars: 200,
    threadTitle: 120,
    outputChars: 120000,
    attachments: 4,
    imageChars: 2000000,
  };

  const STYLE = `
    *{box-sizing:border-box}button,input,select,textarea{font:inherit}
    :host{--accent:#3b5bdb;--accent-ink:#fff}
    .panel{--bg:#fff;--surface:#f5f6f8;--surface-strong:#eceef2;--ink:#171717;--muted:#6b7280;--line:#e5e7eb;--bubble:#fff;--user:var(--accent);--shadow:0 24px 70px #0f172a26,0 2px 10px #0f172a10;color-scheme:light}
    .panel[data-mode=dark]{--bg:#171717;--surface:#212121;--surface-strong:#2f2f2f;--ink:#f3f4f6;--muted:#a1a1aa;--line:#343434;--bubble:#212121;color-scheme:dark}
    @media (prefers-color-scheme:dark){.panel[data-mode=auto]{--bg:#171717;--surface:#212121;--surface-strong:#2f2f2f;--ink:#f3f4f6;--muted:#a1a1aa;--line:#343434;--bubble:#212121;color-scheme:dark}}
    .launcher{pointer-events:auto;position:fixed;right:20px;bottom:20px;width:54px;height:54px;border:0;border-radius:18px;background:var(--accent);color:var(--accent-ink);box-shadow:0 12px 32px #0f172a40;font:700 15px/1 system-ui,-apple-system,sans-serif;cursor:pointer;display:grid;place-items:center;transition:transform .18s ease,box-shadow .18s ease}
    .launcher:hover{transform:translateY(-2px) scale(1.02);box-shadow:0 16px 38px #0f172a48}.launcher:active{transform:translateY(0) scale(.97)}
    .panel{pointer-events:auto;position:fixed;right:20px;bottom:86px;width:min(460px,calc(100vw - 24px));height:min(680px,calc(100vh - 110px));min-width:320px;min-height:380px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);resize:both;overflow:hidden;border:1px solid var(--line);border-radius:18px;background:var(--bg);color:var(--ink);box-shadow:var(--shadow);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;flex-direction:column}
    .panel:not([hidden]){animation:panel-in .22s cubic-bezier(.2,.8,.2,1) both}
    .panel[hidden],.launcher[hidden],[hidden]{display:none!important}
    .head{display:flex;align-items:center;gap:6px;padding:11px 10px 10px 16px;border-bottom:1px solid var(--line);cursor:grab;user-select:none;background:var(--bg)}
    .head:active{cursor:grabbing}
    .brand{flex:1;min-width:0;display:grid}
    .brand strong{font-size:14px;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .brand small{color:var(--muted);font-size:11.5px;line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .icon{width:32px;height:32px;border:0;border-radius:10px;background:transparent;color:var(--muted);cursor:pointer;display:grid;place-items:center;font-size:15px}
    .icon:hover{background:var(--surface);color:var(--ink)}
    .icon[aria-pressed=true]{background:var(--surface);color:var(--accent)}
    .toolbar{display:flex;gap:6px;align-items:center;padding:7px 12px;border-bottom:1px solid var(--line);background:var(--bg);overflow-x:auto}
    .toolbar select{flex:0 1 270px;min-width:150px;max-width:270px;border:0;border-radius:9px;padding:7px 9px;background:var(--surface);color:var(--ink);font-size:12px;outline:none}
    .toolbar select:focus{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 24%,transparent)}
    .toolbar select.think{flex:0 0 auto;max-width:150px}
    .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border:0;border-radius:9px;background:var(--surface);color:var(--muted);font-size:12px;cursor:pointer;white-space:nowrap}
    .chip input{margin:0;accent-color:var(--accent)}
    .chip:has(input:checked){border-color:var(--accent);color:var(--accent)}
    .drawer{border-bottom:1px solid var(--line);padding:10px 12px;display:grid;gap:8px;background:var(--bg)}
    .drawer h4{margin:0;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
    .control{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .control .text{display:grid;min-width:0}
    .control .text span{font-weight:600;font-size:12.5px}
    .control .text small{color:var(--muted);font-size:11.5px}
    .control select,.control button{border:1px solid var(--line);border-radius:9px;padding:5px 9px;background:var(--bg);color:var(--ink);font-size:12px;cursor:pointer}
    .switch{position:relative;width:38px;height:22px;border-radius:999px;background:var(--line);border:0;cursor:pointer;flex:none;transition:background .15s}
    .switch::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transition:transform .15s}
    .switch[aria-checked=true]{background:var(--accent)}.switch[aria-checked=true]::after{transform:translateX(16px)}
    .messages{flex:1;overflow:auto;padding:18px 16px 24px;background:var(--bg);display:flex;flex-direction:column;gap:16px;scrollbar-gutter:stable}
    .msg{max-width:min(82%,720px);padding:10px 13px;border-radius:16px;white-space:pre-wrap;overflow-wrap:anywhere;animation:message-in .24s cubic-bezier(.2,.8,.2,1) both}
    .user{align-self:flex-end;background:var(--user);color:var(--accent-ink);border-bottom-right-radius:5px}
    .assistant{align-self:stretch;max-width:none;padding:0 2px;background:transparent;white-space:normal}
    .assistant.streaming .md::after{content:"";display:inline-block;width:5px;height:1em;margin-left:3px;border-radius:2px;background:var(--accent);vertical-align:-.16em;animation:stream-caret .8s ease-in-out infinite}
    .assistant.error{color:#b42318;background:#fff1f2;border:1px solid #fecdd3;padding:10px 12px}
    .md{max-width:760px;color:var(--ink);overflow-wrap:anywhere}
    .md>*:first-child{margin-top:0}.md>*:last-child{margin-bottom:0}
    .md p{margin:0 0 12px}.md h1,.md h2,.md h3,.md h4{margin:18px 0 8px;line-height:1.25;letter-spacing:-.01em}.md h1{font-size:20px}.md h2{font-size:18px}.md h3{font-size:16px}.md h4{font-size:14px}
    .md ul,.md ol{margin:6px 0 14px;padding-left:22px}.md li{margin:3px 0;padding-left:2px}.md strong{font-weight:650}.md em{font-style:italic}
    .md code{font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface-strong);border-radius:5px;padding:2px 5px}
    .md pre{margin:10px 0 14px;padding:12px 14px;border:1px solid var(--line);border-radius:11px;background:var(--surface);overflow:auto;white-space:pre;font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
    .md pre code{padding:0;background:transparent;border-radius:0;font:inherit}
    .md blockquote{margin:10px 0 14px;padding:2px 0 2px 12px;border-left:3px solid var(--line);color:var(--muted)}
    .md a{color:var(--accent);text-decoration:underline;text-underline-offset:2px}.md a:hover{text-decoration-thickness:2px}
    .table-wrap{max-width:100%;margin:10px 0 16px;overflow-x:auto;border:1px solid var(--line);border-radius:11px}
    .md table{width:100%;border-collapse:collapse;font-size:13px}.md th,.md td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.md th{background:var(--surface);font-weight:650}.md tr:last-child td{border-bottom:0}
    .thumbs{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
    .thumbs img{width:88px;height:88px;object-fit:cover;border-radius:10px;border:1px solid #ffffff55}
    .assistant .thumbs img{border-color:var(--line);width:100%;max-width:280px;height:auto}
    details.reason{margin:0 0 6px;font-size:12px;color:var(--muted)}
    details.reason summary{cursor:pointer;font-weight:600}
    details.reason pre{margin:6px 0 0;white-space:pre-wrap;font:12px ui-monospace,SFMono-Regular,Menlo,monospace}
    .activity{align-self:stretch;max-width:760px;border:0;font-size:12px;color:var(--muted);animation:message-in .22s ease both}
    .activity>summary{display:flex;align-items:center;gap:8px;width:max-content;max-width:100%;padding:2px 2px 5px;cursor:pointer;list-style:none;color:var(--muted);font-weight:500}
    .activity>summary::-webkit-details-marker{display:none}
    .workflow-indicator{position:relative;width:13px;height:13px;border:1.5px solid var(--line);border-radius:50%;flex:none;transition:border-color .2s ease,background .2s ease,transform .2s ease}
    .activity.live .workflow-indicator{border-color:color-mix(in srgb,var(--accent) 28%,var(--line));border-top-color:var(--accent);animation:spin .9s linear infinite}
    .activity.done .workflow-indicator{border-color:var(--muted);background:var(--muted);transform:scale(.82)}
    .activity.done .workflow-indicator::after{content:"";position:absolute;left:3px;top:1px;width:4px;height:7px;border:solid var(--bg);border-width:0 1.5px 1.5px 0;transform:rotate(45deg)}
    .workflow-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.workflow-chevron{font-size:16px;line-height:1;transition:transform .2s ease}.activity[open] .workflow-chevron{transform:rotate(90deg)}
    .workflow-body{position:relative;display:grid;gap:1px;padding:1px 0 2px 20px}
    .workflow-body::before{content:"";position:absolute;left:8px;top:7px;bottom:11px;width:1px;background:var(--line)}
    .step{display:flex;gap:8px;align-items:flex-start;padding:4px 2px;font-size:12px;color:var(--muted)}
    .step .dot{width:7px;height:7px;border-radius:50%;background:var(--accent);margin:6px 0 0 -15px;flex:none;box-shadow:0 0 0 3px var(--bg)}
    .step.live .dot{animation:pulse 1.2s ease-in-out infinite}
    .tool{position:relative;align-self:stretch;border:0;background:transparent;font-size:12px;overflow:visible;animation:task-in .2s ease both}
    .tool summary{display:flex;align-items:flex-start;gap:7px;padding:5px 2px;cursor:pointer;list-style:none}
    .tool summary::-webkit-details-marker{display:none}
    .tool .marker{position:relative;width:11px;height:11px;margin:3px 0 0 -18px;border-radius:50%;background:var(--bg);border:1.5px solid var(--line);flex:none;box-shadow:0 0 0 3px var(--bg);transition:background .2s ease,border-color .2s ease,transform .2s ease}
    .tool .marker.run{border-color:color-mix(in srgb,var(--accent) 30%,var(--line));border-top-color:var(--accent);animation:spin .9s linear infinite}
    .tool .marker.ok{background:var(--muted);border-color:var(--muted);transform:scale(.86)}.tool .marker.ok::after{content:"";position:absolute;left:2.5px;top:.5px;width:3px;height:5px;border:solid var(--bg);border-width:0 1.2px 1.2px 0;transform:rotate(45deg)}
    .tool .marker.err{background:#dc2626;border-color:#dc2626}.tool .marker.err::before,.tool .marker.err::after{content:"";position:absolute;left:4px;top:1px;width:1px;height:6px;background:#fff}.tool .marker.err::before{transform:rotate(45deg)}.tool .marker.err::after{transform:rotate(-45deg)}
    .tool .name{font:600 12px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}
    .tool .source{color:var(--muted);font-size:11.5px}.tool .state{margin-left:auto;font-size:10.5px;color:var(--muted);white-space:nowrap;transition:color .2s ease}.tool .state.ok{color:#15803d}.tool .state.err{color:#b42318}.tool .state.run{color:var(--accent)}
    .tool pre{margin:2px 0 7px;padding:9px 10px;border:1px solid var(--line);border-radius:9px;background:var(--surface);white-space:pre-wrap;overflow-wrap:anywhere;font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--ink);max-height:160px;overflow:auto;animation:reveal .18s ease both}
    .tool pre b{display:block;font:600 10.5px system-ui;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:3px}
    .tool-progress{display:block;padding:1px 2px 5px;color:var(--muted);font-size:11.5px;font-style:italic;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;animation:reveal .18s ease both}
    .setup{align-self:stretch;border:1px solid #fde68a;background:#fffbeb;color:#78350f;border-radius:14px;padding:12px 14px;display:grid;gap:6px;font-size:13px}
    .panel[data-mode=dark] .setup{background:#3b2f0b;border-color:#a16207;color:#fef3c7}
    .setup strong{font-size:13.5px}.setup p{margin:0}
    .setup-actions{display:flex;gap:8px;margin-top:4px}
    .setup-actions button{border:1px solid #fcd34d;border-radius:10px;padding:6px 11px;background:#fff;color:#78350f;font-size:12.5px;cursor:pointer}
    .setup-actions button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
    .setup.blocked{border-color:#fecaca;background:#fee4e2;color:#7f1d1d}
    .panel[data-mode=dark] .setup.blocked{background:#3f1212;border-color:#b91c1c;color:#fee2e2}
    .setup.blocked .setup-actions button{border-color:#fca5a5;color:#7f1d1d}
    .setup-wrap{padding:14px 16px 0;background:var(--bg)}.setup-wrap:empty{display:none}
    .suggestions{display:flex;flex-wrap:wrap;gap:6px}
    .suggestions button{border:1px solid var(--line);border-radius:999px;background:var(--bubble);color:var(--ink);padding:6px 11px;font-size:12px;cursor:pointer;text-align:left}
    .suggestions button:hover{border-color:var(--accent)}
    .composer{border-top:1px solid var(--line);padding:10px 12px 9px;background:var(--bg)}
    .attach-strip{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
    .attach-strip figure{position:relative;margin:0}
    .attach-strip img{width:56px;height:56px;object-fit:cover;border-radius:10px;border:1px solid var(--line)}
    .attach-strip button{position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:0;background:var(--ink);color:var(--bg);font-size:12px;cursor:pointer;line-height:1}
    .compose-row{display:flex;gap:8px;align-items:flex-end;border:1px solid var(--line);border-radius:16px;padding:6px 6px 6px 9px;background:var(--bg);box-shadow:0 1px 2px #0f172a08}
    .compose-row:focus-within{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
    .compose-row textarea{flex:1;min-width:0;border:0;outline:0;resize:none;background:transparent;color:var(--ink);max-height:140px;padding:6px 2px;line-height:1.45}
    .send{width:34px;height:34px;border:0;border-radius:11px;background:var(--accent);color:var(--accent-ink);cursor:pointer;display:grid;place-items:center;font-size:15px;flex:none;transition:transform .15s ease,filter .15s ease}.send:not(:disabled):hover{transform:translateY(-1px);filter:brightness(1.04)}.send:not(:disabled):active{transform:scale(.94)}
    .send:disabled{opacity:.45;cursor:default}
    .stop{background:#0f172a}
    .telemetry{margin:5px 2px 0;color:var(--muted);font-size:10.5px}
    .telemetry summary{width:max-content;cursor:pointer;list-style:none;padding:1px 0}.telemetry summary::-webkit-details-marker{display:none}.telemetry summary::after{content:" · details";opacity:.7}.telemetry[open] summary::after{content:" · hide"}
    .status{display:flex;gap:5px 12px;flex-wrap:wrap;padding-top:5px;font-size:10.5px;color:var(--muted)}
    .status b{font-weight:600;color:var(--ink)}
    .meter{display:inline-block;width:42px;height:3px;border-radius:2px;background:var(--line);vertical-align:middle;overflow:hidden}
    .meter i{display:block;height:100%;background:var(--accent)}
    /* Transcript cards (SPEC 7.4): site-authored UI drawn from a bounded tree. */
    .card{margin:6px 0 2px;border:1px solid var(--line);border-radius:14px;background:var(--bg);padding:12px 13px;display:grid;gap:9px;animation:reveal .2s ease both}
    .panel[data-tool-view=compact] .card{margin-left:-18px}
    .card>.card-title{font:650 13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}
    .card-text{margin:0;font-size:13px;color:var(--ink);white-space:pre-wrap;overflow-wrap:anywhere}
    .card-text.muted{color:var(--muted);font-size:12.5px}
    .card-text.heading{font-weight:650;font-size:13.5px}
    .card-list{display:grid;gap:4px}
    .card-item{display:grid;gap:2px;padding:8px 10px;border:1px solid var(--line);border-radius:11px;background:var(--surface);text-align:left;color:var(--ink);font:inherit}
    button.card-item{cursor:pointer}button.card-item:hover{border-color:var(--accent)}
    .card-item strong{font-size:12.5px;font-weight:600}
    .card-item small{color:var(--muted);font-size:11.5px;white-space:pre-wrap;overflow-wrap:anywhere}
    .card-actions{display:flex;flex-wrap:wrap;gap:7px}
    .card-button{border:1px solid var(--line);border-radius:10px;padding:7px 12px;background:var(--bg);color:var(--ink);font-size:12.5px;font-weight:600;cursor:pointer}
    .card-button:hover{border-color:var(--accent)}
    .card-button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
    .card-button.danger{border-color:#fca5a5;color:#b42318}
    .card-button:disabled{opacity:.5;cursor:default}
    .card-form{display:grid;gap:9px;margin:0}
    .card-field{display:grid;gap:4px;font-size:12.5px;color:var(--ink)}
    .card-field>span{font-weight:600}
    .card-field input[type=text],.card-field select{border:1px solid var(--line);border-radius:10px;padding:8px 10px;background:var(--bg);color:var(--ink);font-size:13px;outline:0}
    .card-field input[type=text]:focus,.card-field select:focus{border-color:var(--accent)}
    .card-field.check{grid-template-columns:auto 1fr;align-items:center;gap:8px}
    .card-field.check>span{font-weight:500}
    .card-field input[type=checkbox]{width:17px;height:17px;accent-color:var(--accent);margin:0}
    .card-note{margin:0;color:var(--muted);font-size:11.5px}
    /* Thread panel (SPEC 7.6 / 14.2): conversations the host stores. */
    .threads{border-bottom:1px solid var(--line);background:var(--bg);max-height:232px;display:flex;flex-direction:column}
    .thread-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:9px 12px 5px}
    .thread-head span{color:var(--muted);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
    .thread-new{border:1px solid var(--line);border-radius:9px;padding:4px 10px;background:var(--bg);color:var(--ink);font-size:12px;cursor:pointer}
    .thread-new:hover{border-color:var(--accent)}
    .thread-list{overflow:auto;padding:0 8px 9px;display:grid;gap:2px}
    .thread-row{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:4px;border-radius:10px}
    .thread-row:hover{background:var(--surface)}
    .thread-row.current{background:var(--surface)}
    .thread-open{min-width:0;border:0;background:transparent;color:var(--ink);font-size:12.5px;text-align:left;padding:8px 8px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .thread-row.current .thread-open{font-weight:600}
    .thread-act{width:26px;height:26px;border:0;border-radius:8px;background:transparent;color:var(--muted);font-size:12px;cursor:pointer}
    .thread-act:hover{background:var(--surface-strong);color:var(--ink)}
    .thread-busy{width:9px;height:9px;margin-right:4px;border-radius:50%;border:1.5px solid var(--line);border-top-color:var(--accent);animation:spin .9s linear infinite}
    .thread-empty,.thread-error{padding:8px 10px;color:var(--muted);font-size:12px}
    .thread-error{color:#b42318}
    .overlay{pointer-events:auto;position:fixed;inset:0;background:#0f172a99;display:grid;place-items:center;padding:18px;font:14px/1.5 system-ui,-apple-system,sans-serif}
    .consent{width:min(520px,100%);max-height:calc(100vh - 36px);display:flex;flex-direction:column;background:#fff;color:#0f172a;border-radius:20px;box-shadow:0 30px 90px #0008;overflow:hidden}
    .consent-head{padding:20px 24px 12px;border-bottom:1px solid #e6e9f0}
    .consent-body{flex:1;min-height:0;overflow-y:scroll;scrollbar-gutter:stable;padding:12px 24px;scrollbar-width:auto}
    .consent-body::-webkit-scrollbar{width:12px}.consent-body::-webkit-scrollbar-thumb{background:#c7cdd8;border-radius:6px;border:3px solid #fff}.consent-body::-webkit-scrollbar-track{background:#f3f4f8}
    .consent-foot{padding:12px 24px 18px;border-top:1px solid #e6e9f0;background:#fff;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
    .consent-hint{font-size:12px;color:#64748b}.consent-hint[hidden]{display:none}
    .consent h2{margin:0 0 4px;font-size:19px}
    .consent .origin{color:#64748b;overflow-wrap:anywhere;font-size:13px}
    .consent .scope{padding:10px 12px;margin:8px 0;background:#f6f7fb;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}
    .consent details{margin:8px 0;font-size:13px}.consent summary{cursor:pointer;font-weight:600}
    .consent pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f6f7fb;padding:10px;border-radius:10px;margin:6px 0 0}
    .consent label.field{display:grid;gap:5px;margin:10px 0;font-weight:600;font-size:13px}
    .consent label.field input,.consent label.field select{font-weight:400;border:1px solid #d5dae3;border-radius:10px;padding:8px 10px;background:#fff;color:#0f172a}
    .consent label.field input[type=checkbox]{justify-self:start;width:18px;height:18px;accent-color:var(--accent)}
    .consent .validation{min-height:18px;color:#b42318;font-size:12px}
    .consent .providers{display:grid;gap:6px;margin:6px 0 10px}
    .consent .providers label{display:flex;gap:8px;align-items:center;font-size:13px}
    .consent .notice{font-size:12px;color:#64748b;margin:10px 0 0}
    .consent .actions{display:flex;justify-content:flex-end;gap:8px;margin:0 0 0 auto}
    .consent .actions button{border:1px solid #d5dae3;border-radius:11px;padding:9px 15px;background:#fff;color:#0f172a;cursor:pointer;font-weight:600}
    .consent .actions .allow{border-color:var(--accent);background:var(--accent);color:var(--accent-ink)}
    .consent .level{display:inline-block;padding:2px 8px;border-radius:999px;background:var(--accent);color:var(--accent-ink);font-size:11px;font-weight:600;vertical-align:middle;margin-left:6px}
    /* Chat-style conversation shell with host-owned controls in the slots. */
    .panel{width:min(600px,calc(100vw - 24px));height:min(760px,calc(100vh - 110px));border-radius:22px}
    .head{padding:12px 12px 11px 18px}.brand strong{font-size:15px}.brand small{font-size:11px}
    .messages{padding:24px 28px 30px;gap:20px}
    .messages.empty{justify-content:center;padding-top:72px;padding-bottom:28px}
    .welcome{width:100%;max-width:500px;margin:auto;display:grid;gap:18px;animation:message-in .3s ease both}
    .welcome h2{margin:0;color:var(--ink);font-size:25px;line-height:1.16;letter-spacing:-.025em;font-weight:650}
    .welcome p{margin:-9px 0 0;color:var(--muted);font-size:13.5px}
    .suggestions{display:grid;gap:4px}
    .suggestions button{display:flex;align-items:center;gap:12px;width:100%;border:0;border-radius:12px;background:transparent;color:var(--muted);padding:10px 8px;font-size:14px}
    .suggestions button::before{content:"✦";width:22px;color:var(--muted);font-size:15px;text-align:center}
    .suggestions button:nth-child(2n)::before{content:"⌘"}.suggestions button:hover{border:0;background:var(--surface);color:var(--ink)}
    .msg{font-size:14px}.user{background:var(--surface);color:var(--ink);border-bottom-right-radius:16px;padding:9px 13px}.assistant{line-height:1.6}
    .msg.stored{opacity:.92}
    .stored-mark{display:block;margin:0 0 4px;color:var(--muted);font-size:10.5px;letter-spacing:.04em;text-transform:uppercase}
    .composer{position:relative;border-top:0;padding:8px 14px 12px;background:linear-gradient(180deg,transparent 0,var(--bg) 13%)}
    .compose-shell{position:relative;border:1px solid var(--line);border-radius:22px;padding:10px;background:var(--bg);box-shadow:0 10px 30px #0f172a0d,0 1px 2px #0f172a0d;transition:border-color .15s,box-shadow .15s}
    .compose-shell:focus-within{border-color:color-mix(in srgb,var(--ink) 22%,var(--line));box-shadow:0 12px 34px #0f172a14}
    .compose-shell textarea{display:block;width:100%;min-height:45px;max-height:150px;padding:2px 5px 8px;border:0;outline:0;resize:none;background:transparent;color:var(--ink);line-height:1.5;font-size:14px}
    .compose-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0}
    .compose-left,.compose-right{display:flex;align-items:center;gap:4px;min-width:0}.compose-left{flex:1}
    .compose-control{height:32px;border:0;border-radius:10px;background:transparent;color:var(--ink);cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:0 8px;white-space:nowrap;font-size:12.5px}
    .compose-control:hover,.compose-control[aria-expanded=true]{background:var(--surface)}.compose-control:disabled{opacity:.45;cursor:default}
    .attach.compose-control{width:32px;padding:0;justify-content:center;font-size:19px}.context-toggle{padding:0;width:32px;justify-content:center;font-size:16px}.context-toggle input{position:absolute;opacity:0;pointer-events:none}.context-toggle:has(input:checked){background:var(--surface-strong);color:var(--accent)}
    .model-picker{position:relative;min-width:0}.model-button{max-width:190px}.model-label{overflow:hidden;text-overflow:ellipsis}.chevron{font-size:13px;color:var(--muted)}
    .model-menu{position:absolute;left:0;bottom:calc(100% + 10px);z-index:8;width:min(330px,calc(100vw - 70px));max-height:360px;overflow:auto;padding:8px;border:1px solid var(--line);border-radius:17px;background:var(--bg);box-shadow:0 20px 50px #0f172a2b,0 2px 8px #0f172a12;animation:popover-in .15s ease both}
    .menu-title{padding:7px 10px 8px;color:var(--muted);font-size:12px}.menu-group{padding:7px 10px 3px;color:var(--muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em}
    .model-option{width:100%;display:flex;align-items:center;gap:9px;border:0;border-radius:11px;background:transparent;color:var(--ink);padding:9px 10px;cursor:pointer;text-align:left}.model-option:hover,.model-option.selected{background:var(--surface)}.model-option span:first-child{flex:1}.model-option small{color:var(--muted)}.model-check{width:14px;font-weight:700}
    .think{height:32px;max-width:130px;border:0;border-radius:10px;background:transparent;color:var(--muted);padding:0 5px;font-size:12px;outline:0;cursor:pointer}.think:hover{background:var(--surface);color:var(--ink)}
    .send{width:36px;height:36px;border-radius:50%;background:var(--ink);color:var(--bg);font-size:17px}.stop{background:var(--surface-strong);color:var(--ink);font-size:12px}
    .telemetry{position:relative;margin:0;color:var(--muted);font-size:12px}.telemetry>summary{display:grid;place-items:center;width:32px;height:32px;padding:0;border-radius:10px;cursor:pointer;list-style:none}.telemetry>summary::after,.telemetry[open]>summary::after{content:none}.telemetry>summary::-webkit-details-marker{display:none}.telemetry>summary:hover,.telemetry[open]>summary{background:var(--surface)}
    .usage-ring{width:19px;height:19px;border-radius:50%;background:conic-gradient(var(--usage-color,var(--accent)) var(--usage-angle,0deg),var(--line) 0);display:grid;place-items:center}.usage-ring::after{content:"";width:11px;height:11px;border-radius:50%;background:var(--bg)}
    .status{position:absolute;right:-48px;bottom:43px;z-index:9;width:min(420px,calc(100vw - 54px));max-height:min(560px,calc(100vh - 180px));overflow:auto;display:block;padding:18px;border:1px solid var(--line);border-radius:18px;background:var(--bg);color:var(--ink);box-shadow:0 24px 60px #0f172a30,0 2px 8px #0f172a12;animation:popover-in .15s ease both}
    .usage-section+.usage-section{margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}.usage-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-bottom:8px}.usage-heading span{color:var(--muted);font-size:12px}.usage-heading strong{font-size:13px;font-weight:600}
    .usage-bar{height:7px;border-radius:999px;background:var(--surface-strong);overflow:hidden}.usage-bar i{display:block;height:100%;border-radius:inherit;background:var(--bar-color,var(--accent));transition:width .25s ease}
    .usage-rows{display:grid;gap:9px;margin-top:12px}.usage-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}.usage-row .label{display:flex;align-items:center;gap:8px;min-width:0}.usage-row .swatch{width:9px;height:9px;border-radius:3px;background:var(--row-color,var(--accent));flex:none}.usage-row .value{color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}.quota-row{display:grid;gap:6px;margin-top:12px}.quota-line{display:flex;justify-content:space-between;gap:10px}.quota-line span:last-child{color:var(--muted);text-align:right}.usage-note{margin:10px 0 0;color:var(--muted);font-size:11.5px;line-height:1.45}.usage-empty{color:var(--muted)}
    .context-glance{width:100%;display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:9px;margin-top:7px;padding:0 5px;border:0;background:transparent;color:var(--muted);font-size:10.5px;cursor:pointer;text-align:left}.context-glance strong{font-weight:500;color:var(--muted);font-variant-numeric:tabular-nums}.context-track{height:3px;border-radius:999px;background:var(--surface-strong);overflow:hidden}.context-track i{display:block;height:100%;width:0;background:var(--accent);border-radius:inherit}
    .activity{font-size:13px}.activity>summary{padding:4px 0 6px}.workflow-body{gap:2px}
    .panel[data-tool-view=compact] .tool .source,.panel[data-tool-view=compact] .tool .state{display:none}
    .panel[data-tool-view=detailed] .workflow-body{padding:5px 0}.panel[data-tool-view=detailed] .workflow-body::before{display:none}
    .panel[data-tool-view=detailed] .tool{margin:7px 0;border:1px solid var(--line);border-radius:15px;background:var(--bg);overflow:hidden}.panel[data-tool-view=detailed] .tool summary{padding:12px 13px}.panel[data-tool-view=detailed] .tool .marker{margin:3px 0 0}.panel[data-tool-view=detailed] .tool pre{margin:0 12px 12px;max-height:220px}.panel[data-tool-view=detailed] .tool .name{font-size:12.5px;overflow-wrap:anywhere}
    .panel[data-tool-view=detailed] .card{margin:0 12px 12px}
    @keyframes panel-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
    @keyframes popover-in{from{opacity:0;transform:translateY(5px) scale(.985)}to{opacity:1;transform:none}}
    @keyframes message-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
    @keyframes task-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
    @keyframes reveal{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.42;transform:scale(.72)}}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes stream-caret{0%,100%{opacity:.25}50%{opacity:1}}
    @media (prefers-reduced-motion:reduce){.panel:not([hidden]),.msg,.activity,.tool,.tool pre,.launcher,.send,.workflow-indicator,.tool .marker,.assistant.streaming .md::after,.card,.thread-busy{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
    @media (max-width:520px){.messages{padding:18px 14px 22px}.messages.empty{padding-top:44px}.msg{max-width:90%}.welcome h2{font-size:22px}.model-button{max-width:140px}.status{right:-48px}.context-glance{grid-template-columns:auto 1fr}.context-glance strong{grid-column:1/-1;justify-self:end;margin-top:-4px}}
  `;

  const PANEL_HTML = `<section class="panel" hidden data-mode="light" data-tool-view="compact" role="dialog" aria-label="AI assistant">
  <header class="head">
    <button class="icon thread-toggle" title="Conversations" aria-label="Conversations" aria-pressed="false" hidden>☰</button>
    <div class="brand"><strong class="name">AI assistant</strong><small class="sub">अर्जुनः</small></div>
    <span class="head-slot"></span>
    <button class="icon options" title="Options" aria-label="Options" aria-pressed="false">⚙</button>
    <button class="icon clear" title="Clear chat" aria-label="Clear chat">↺</button>
    <button class="icon close" title="Close" aria-label="Close">×</button>
  </header>
  <div class="threads" hidden>
    <div class="thread-head"><span>Conversations</span><button class="thread-new" type="button">New</button></div>
    <div class="thread-list"></div>
  </div>
  <div class="drawer" hidden></div>
  <div class="setup-wrap"></div>
  <main class="messages"></main>
  <footer class="composer">
    <div class="attach-strip" hidden></div>
    <div class="compose-shell">
      <textarea rows="1" maxlength="12000" placeholder="Ask about this site…" aria-label="Message"></textarea>
      <div class="compose-actions">
        <div class="compose-left">
          <button class="attach compose-control" title="Attach image" aria-label="Attach image" hidden>＋</button>
          <span class="compose-left-slot"></span>
        </div>
        <div class="compose-right">
          <span class="compose-right-slot"></span>
          <button class="send" title="Send" aria-label="Send">↑</button>
          <button class="send stop" title="Stop" aria-label="Stop" hidden>■</button>
        </div>
      </div>
    </div>
    <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
    <span class="composer-foot-slot"></span>
  </footer>
</section>`;

  function build(doc, html) {
    // Static, renderer-authored markup only; parsed without touching innerHTML.
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const fragment = doc.createDocumentFragment();
    fragment.append(...parsed.body.childNodes);
    return fragment;
  }

  // ---------------------------------------------------------------- markdown

  function appendMarkdownInline(doc, parent, value) {
    const text = String(value ?? "");
    const tokens =
      /\*\*([^*\n]+)\*\*|`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let cursor = 0;
    for (const match of text.matchAll(tokens)) {
      if (match.index > cursor)
        parent.append(doc.createTextNode(text.slice(cursor, match.index)));
      if (match[1] != null) {
        const strong = doc.createElement("strong");
        strong.textContent = match[1];
        parent.append(strong);
      } else if (match[2] != null) {
        const code = doc.createElement("code");
        code.textContent = match[2];
        parent.append(code);
      } else {
        const link = doc.createElement("a");
        link.textContent = match[3];
        link.href = match[4];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parent.append(link);
      }
      cursor = match.index + match[0].length;
    }
    if (cursor < text.length)
      parent.append(doc.createTextNode(text.slice(cursor)));
  }

  function markdownCells(line) {
    let value = line.trim();
    if (value.startsWith("|")) value = value.slice(1);
    if (value.endsWith("|")) value = value.slice(0, -1);
    return value.split("|").map((cell) => cell.trim());
  }

  function isMarkdownTableDivider(line) {
    const cells = markdownCells(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  /** Render a small safe Markdown subset without ever interpreting model HTML. */
  function renderMarkdown(value, doc = document) {
    const container = doc.createElement("div");
    container.className = "md";
    const lines = String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const startsBlock = (index) => {
      const line = lines[index] ?? "";
      return (
        !line.trim() ||
        /^\s*```/.test(line) ||
        /^\s*#{1,4}\s+/.test(line) ||
        /^\s*>\s?/.test(line) ||
        /^\s*(?:[-*]|\d+\.)\s+/.test(line) ||
        /^\s*-{3,}\s*$/.test(line) ||
        (index + 1 < lines.length &&
          line.includes("|") &&
          isMarkdownTableDivider(lines[index + 1]))
      );
    };
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (!line.trim()) {
        index++;
        continue;
      }
      const fence = line.match(/^\s*```([^\s`]*)\s*$/);
      if (fence) {
        const body = [];
        index++;
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index]))
          body.push(lines[index++]);
        if (index < lines.length) index++;
        const pre = doc.createElement("pre");
        const code = doc.createElement("code");
        if (fence[1]) code.dataset.language = fence[1];
        code.textContent = body.join("\n");
        pre.append(code);
        container.append(pre);
        continue;
      }
      if (
        line.includes("|") &&
        index + 1 < lines.length &&
        isMarkdownTableDivider(lines[index + 1])
      ) {
        const headers = markdownCells(line);
        index += 2;
        const wrapper = doc.createElement("div");
        wrapper.className = "table-wrap";
        const table = doc.createElement("table");
        const head = doc.createElement("thead");
        const headRow = doc.createElement("tr");
        for (const value of headers) {
          const cell = doc.createElement("th");
          appendMarkdownInline(doc, cell, value);
          headRow.append(cell);
        }
        head.append(headRow);
        table.append(head);
        const body = doc.createElement("tbody");
        while (index < lines.length && lines[index].includes("|")) {
          const row = doc.createElement("tr");
          const cells = markdownCells(lines[index++]);
          for (let column = 0; column < headers.length; column++) {
            const cell = doc.createElement("td");
            appendMarkdownInline(doc, cell, cells[column] ?? "");
            row.append(cell);
          }
          body.append(row);
        }
        table.append(body);
        wrapper.append(table);
        container.append(wrapper);
        continue;
      }
      const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
      if (heading) {
        const node = doc.createElement(`h${heading[1].length}`);
        appendMarkdownInline(doc, node, heading[2]);
        container.append(node);
        index++;
        continue;
      }
      const list = line.match(/^\s*([-*]|\d+\.)\s+(.+)$/);
      if (list) {
        const ordered = /\d/.test(list[1]);
        const node = doc.createElement(ordered ? "ol" : "ul");
        while (index < lines.length) {
          const item = lines[index].match(/^\s*([-*]|\d+\.)\s+(.+)$/);
          if (!item || /\d/.test(item[1]) !== ordered) break;
          const entry = doc.createElement("li");
          appendMarkdownInline(doc, entry, item[2]);
          node.append(entry);
          index++;
        }
        container.append(node);
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        const quote = doc.createElement("blockquote");
        const values = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index]))
          values.push(lines[index++].replace(/^\s*>\s?/, ""));
        appendMarkdownInline(doc, quote, values.join(" "));
        container.append(quote);
        continue;
      }
      if (/^\s*-{3,}\s*$/.test(line)) {
        container.append(doc.createElement("hr"));
        index++;
        continue;
      }
      const paragraph = [];
      while (index < lines.length && !startsBlock(index))
        paragraph.push(lines[index++].trim());
      if (!paragraph.length) paragraph.push(lines[index++].trim());
      const node = doc.createElement("p");
      appendMarkdownInline(doc, node, paragraph.join(" "));
      container.append(node);
    }
    return container;
  }

  // ------------------------------------------------------------------- cards

  /**
   * Draw one validated card (SPEC 7.4). `onAction(action, context)` receives the
   * declared action plus, for forms, the collected values. Every string becomes
   * a text node, so a card cannot inject markup into the renderer.
   */
  function renderCard(card, onAction, doc = document) {
    const root = doc.createElement("div");
    root.className = "card";
    if (card.id) root.dataset.cardId = card.id;
    if (card.title) {
      const title = doc.createElement("div");
      title.className = "card-title";
      title.textContent = card.title;
      root.append(title);
    }
    const fire = (action, values) => {
      try {
        onAction?.(action, { cardId: card.id ?? null, values: values ?? null });
      } catch {
        /* host errors never break the transcript */
      }
    };
    let actions = null;
    const actionRow = () => {
      if (!actions || actions !== root.lastElementChild) {
        actions = doc.createElement("div");
        actions.className = "card-actions";
        root.append(actions);
      }
      return actions;
    };
    for (const node of card.children) {
      if (node.type === "text") {
        const text = doc.createElement("p");
        text.className = `card-text${node.style && node.style !== "body" ? ` ${node.style}` : ""}`;
        text.textContent = node.text;
        root.append(text);
        actions = null;
      } else if (node.type === "list") {
        const list = doc.createElement("div");
        list.className = "card-list";
        for (const item of node.items) {
          const entry = doc.createElement(item.action ? "button" : "div");
          entry.className = "card-item";
          if (item.action) entry.type = "button";
          const title = doc.createElement("strong");
          title.textContent = item.title;
          entry.append(title);
          if (item.description) {
            const description = doc.createElement("small");
            description.textContent = item.description;
            entry.append(description);
          }
          if (item.action)
            entry.addEventListener("click", () => fire(item.action));
          list.append(entry);
        }
        root.append(list);
        actions = null;
      } else if (node.type === "button") {
        const button = doc.createElement("button");
        button.type = "button";
        button.className = `card-button${node.style ? ` ${node.style}` : ""}`;
        button.textContent = node.label;
        button.addEventListener("click", () => fire(node.action));
        actionRow().append(button);
      } else if (node.type === "form") {
        const form = doc.createElement("form");
        form.className = "card-form";
        const controls = new Map();
        for (const field of node.fields) {
          const label = doc.createElement("label");
          label.className = `card-field${field.type === "checkbox" ? " check" : ""}`;
          const name = doc.createElement("span");
          name.textContent = field.label;
          let control;
          if (field.type === "select") {
            control = doc.createElement("select");
            for (const option of field.options) {
              const item = doc.createElement("option");
              item.value = option.value;
              item.textContent = option.label;
              item.selected = option.value === field.default;
              control.append(item);
            }
          } else if (field.type === "checkbox") {
            control = doc.createElement("input");
            control.type = "checkbox";
            control.checked = field.default === true;
          } else {
            control = doc.createElement("input");
            control.type = "text";
            control.autocomplete = "off";
            if (field.placeholder) control.placeholder = field.placeholder;
            if (field.required) control.required = true;
            control.value = field.default ?? "";
          }
          control.setAttribute("aria-label", field.label);
          controls.set(field.id, { field, control });
          label.append(
            field.type === "checkbox" ? control : name,
            field.type === "checkbox" ? name : control,
          );
          form.append(label);
        }
        const submit = doc.createElement("button");
        submit.type = "submit";
        submit.className = "card-button primary";
        submit.textContent = node.submitLabel ?? "Submit";
        form.append(submit);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          const values = {};
          for (const [id, { field, control }] of controls)
            values[id] =
              field.type === "checkbox" ? control.checked : control.value;
          for (const [, { field, control }] of controls)
            if (
              field.required &&
              field.type === "input" &&
              !String(control.value).trim()
            ) {
              control.focus();
              return;
            }
          fire(node.action, values);
        });
        root.append(form);
        actions = null;
      }
    }
    return root;
  }

  /** The visible user text a form's `message` action produces (SPEC 7.4). */
  function cardMessageText(action, card, context) {
    const lines = [action.text];
    if (context?.values && card) {
      const labels = new Map();
      for (const node of card.children)
        if (node.type === "form")
          for (const field of node.fields) labels.set(field.id, field.label);
      for (const [id, value] of Object.entries(context.values))
        lines.push(`${labels.get(id) ?? id}: ${value}`);
    }
    return lines.join("\n");
  }

  // -------------------------------------------------------------------- view

  function pretty(text) {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return String(text ?? "");
    }
  }

  function randomId() {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  }

  /**
   * Builds the panel and owns everything inside it. The host supplies callbacks
   * and fills the three slots with whatever chrome belongs to its mode.
   */
  function createChatView(config = {}) {
    const doc = config.document ?? document;
    const host = config.host ?? {};
    const panel = build(doc, PANEL_HTML).firstElementChild;
    const q = (selector) => panel.querySelector(selector);
    const refs = {
      panel,
      head: q(".head"),
      name: q(".name"),
      sub: q(".sub"),
      threadToggle: q(".thread-toggle"),
      threadPanel: q(".threads"),
      threadList: q(".thread-list"),
      threadNew: q(".thread-new"),
      optionsButton: q(".options"),
      clearButton: q(".clear"),
      closeButton: q(".close"),
      drawer: q(".drawer"),
      setupWrap: q(".setup-wrap"),
      messages: q(".messages"),
      composer: q(".composer"),
      attachStrip: q(".attach-strip"),
      input: q("textarea"),
      attachButton: q(".attach"),
      fileInput: q("input[type=file]"),
      sendButton: q(".send:not(.stop)"),
      stopButton: q(".stop"),
      headSlot: q(".head-slot"),
      composeLeftSlot: q(".compose-left-slot"),
      composeRightSlot: q(".compose-right-slot"),
      composerFootSlot: q(".composer-foot-slot"),
    };

    let options = {
      name: "AI assistant",
      greeting: "",
      placeholder: "",
      suggestions: [],
      theme: null,
      toolCallView: "compact",
      controls: [],
    };
    let controlValues = {};
    let attachments = [];
    let busy = false;
    let composerBlocked = false;
    let activeThreadId = null;
    let threadSummaries = [];
    let currentTurn = null;
    let activityNode = null;
    let threadsHost = config.host?.threads ?? null;
    // One transcript per thread. `null` is the ephemeral single conversation
    // used when the host stores nothing (SPEC 7.6: threads are optional).
    const transcripts = new Map([[null, []]]);
    const liveCards = new Map();

    const entries = () => {
      if (!transcripts.has(activeThreadId)) transcripts.set(activeThreadId, []);
      return transcripts.get(activeThreadId);
    };
    const scroll = () => {
      refs.messages.scrollTop = refs.messages.scrollHeight;
    };
    const displaying = (threadId) => threadId === activeThreadId;

    // ------------------------------------------------------------ transcript

    function bubbleFor(entry) {
      const item = doc.createElement("div");
      item.className = `msg ${entry.role}${entry.error ? " error" : ""}${entry.source === "site" ? " stored" : ""}`;
      if (entry.source === "site") {
        const mark = doc.createElement("span");
        mark.className = "stored-mark";
        mark.textContent = "Stored by this site";
        item.append(mark);
      }
      if (entry.reasoning) {
        const details = doc.createElement("details");
        details.className = "reason";
        const summary = doc.createElement("summary");
        summary.textContent = "Reasoning";
        const pre = doc.createElement("pre");
        pre.textContent = entry.reasoning;
        details.append(summary, pre);
        item.append(details);
      }
      const parts = Array.isArray(entry.content)
        ? entry.content
        : [{ type: "text", text: entry.content }];
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (text)
        item.append(
          entry.role === "assistant"
            ? renderMarkdown(text, doc)
            : doc.createTextNode(text),
        );
      const images = parts.filter(
        (part) => part.type === "image" && IMAGE_TYPES.includes(part.mediaType),
      );
      if (images.length) {
        const thumbs = doc.createElement("div");
        thumbs.className = "thumbs";
        for (const image of images) {
          const img = doc.createElement("img");
          img.src = `data:${image.mediaType};base64,${image.data}`;
          img.alt = entry.role === "user" ? "Attached image" : "Image";
          thumbs.append(img);
        }
        item.append(thumbs);
      }
      return item;
    }

    function activityFor(entry) {
      const node = doc.createElement("details");
      node.className = "activity done";
      const summary = doc.createElement("summary");
      const indicator = doc.createElement("span");
      indicator.className = "workflow-indicator";
      const title = doc.createElement("span");
      title.className = "workflow-title";
      title.textContent = `${entry.steps.length} step${entry.steps.length === 1 ? "" : "s"} completed`;
      const chevron = doc.createElement("span");
      chevron.className = "workflow-chevron";
      chevron.textContent = "›";
      summary.append(indicator, title, chevron);
      const body = doc.createElement("div");
      body.className = "workflow-body";
      for (const step of entry.steps) body.append(stepNode(step).card);
      node.append(summary, body);
      return node;
    }

    function stepNode(step) {
      const card = doc.createElement("details");
      card.className = "tool";
      card.open = options.toolCallView === "detailed";
      const summary = doc.createElement("summary");
      const marker = doc.createElement("span");
      marker.className = `marker ${step.status === "ok" ? "ok" : step.status === "error" ? "err" : "run"}`;
      const name = doc.createElement("span");
      name.className = "name";
      name.textContent = step.name;
      const source = doc.createElement("span");
      source.className = "source";
      source.textContent = sourceLabel(step.source);
      const state = doc.createElement("span");
      state.className = `state ${step.status === "ok" ? "ok" : step.status === "error" ? "err" : "run"}`;
      state.textContent =
        step.status === "ok"
          ? "done"
          : step.status === "error"
            ? "failed"
            : "running";
      summary.append(marker, name, source, state);
      card.append(summary);
      const progress = doc.createElement("span");
      progress.className = "tool-progress";
      progress.hidden = true;
      card.append(progress);
      if (step.arguments != null)
        card.append(preBlock("Arguments", pretty(step.arguments)));
      if (step.result != null)
        card.append(preBlock("Result", pretty(step.result)));
      if (step.card) card.append(renderCard(step.card, cardAction, doc));
      return { card, marker, state, progress };
    }

    function preBlock(label, text) {
      const pre = doc.createElement("pre");
      const heading = doc.createElement("b");
      heading.textContent = label;
      pre.append(heading, text);
      return pre;
    }

    function sourceLabel(source) {
      return source === "site"
        ? "site tool"
        : source === "backend"
          ? "backend tool"
          : source === "agent"
            ? "agent command"
            : "MCP tool";
    }

    function renderTranscript() {
      refs.messages.textContent = "";
      liveCards.clear();
      for (const entry of entries())
        refs.messages.append(
          entry.type === "activity" ? activityFor(entry) : bubbleFor(entry),
        );
      renderSuggestions();
      scroll();
    }

    function pushEntry(entry) {
      entries().push(entry);
      return entry;
    }

    /** Adds a visible message. `persist` false keeps it out of the transcript. */
    function addBubble(role, content, opts = {}) {
      const entry = {
        type: "message",
        id: randomId(),
        role,
        content,
        createdAt: new Date().toISOString(),
        ...(opts.error ? { error: true } : {}),
        ...(opts.source ? { source: opts.source } : {}),
        ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
      };
      if (opts.persist !== false) pushEntry(entry);
      refs.messages.querySelector(".welcome")?.remove();
      refs.messages.classList.remove("empty");
      const node = bubbleFor(entry);
      refs.messages.append(node);
      scroll();
      return { node, entry };
    }

    function addAssistantResult(result, streamedNode) {
      const message = result.message ?? {};
      const content =
        message.content || "The model returned an empty response.";
      const entry = {
        type: "message",
        id: randomId(),
        role: "assistant",
        content,
        createdAt: new Date().toISOString(),
        ...(message.reasoning ? { reasoning: message.reasoning } : {}),
      };
      const attachmentsOut = (message.attachments ?? []).filter((image) =>
        IMAGE_TYPES.includes(image.mediaType),
      );
      if (attachmentsOut.length)
        entry.content = [
          { type: "text", text: String(content) },
          ...attachmentsOut,
        ];
      pushEntry(entry);
      if (streamedNode?.isConnected) streamedNode.remove();
      refs.messages.append(bubbleFor(entry));
      scroll();
      return entry;
    }

    /** Messages the model should see, plus how many came from the host's store. */
    function modelHistory() {
      const messages = entries().filter(
        (entry) => entry.type === "message" && !entry.error,
      );
      let untrustedPrefix = 0;
      while (
        untrustedPrefix < messages.length &&
        messages[untrustedPrefix].source === "site"
      )
        untrustedPrefix++;
      const recent = messages.slice(-LIMITS.historyMessages);
      return {
        messages: recent.map((entry) => ({
          role: entry.role,
          content: entry.content,
        })),
        untrustedPrefix: Math.max(
          0,
          untrustedPrefix - (messages.length - recent.length),
        ),
      };
    }

    // -------------------------------------------------------------- activity

    function startActivity(turnId, threadId = activeThreadId) {
      const node = doc.createElement("details");
      node.className = "activity live";
      node.dataset.turn = turnId;
      node.open = true;
      const summary = doc.createElement("summary");
      const indicator = doc.createElement("span");
      indicator.className = "workflow-indicator";
      const title = doc.createElement("span");
      title.className = "workflow-title";
      title.textContent = "Thinking…";
      const chevron = doc.createElement("span");
      chevron.className = "workflow-chevron";
      chevron.textContent = "›";
      summary.append(indicator, title, chevron);
      const body = doc.createElement("div");
      body.className = "workflow-body";
      node.append(summary, body);
      currentTurn = {
        id: turnId,
        threadId,
        startedAt: Date.now(),
        steps: new Map(),
        records: [],
        promptTokens: 0,
        completionTokens: 0,
        timer: null,
        title,
        body,
        node,
        outputNode: null,
        outputText: "",
        outputRender: 0,
        reasoning: null,
      };
      if (displaying(threadId)) {
        refs.messages.querySelector(".welcome")?.remove();
        refs.messages.append(node);
        activityNode = node;
        scroll();
      }
      currentTurn.timer = setInterval(() => {
        if (!currentTurn) return;
        const seconds = ((Date.now() - currentTurn.startedAt) / 1000).toFixed(
          1,
        );
        currentTurn.title.textContent = `${currentTurn.label ?? "Thinking…"} ${seconds}s`;
      }, 200);
      renderThreadList();
      return currentTurn;
    }

    function finishActivity(keep) {
      const turn = currentTurn;
      if (!turn) return null;
      clearInterval(turn.timer);
      if (turn.outputRender) cancelAnimationFrame(turn.outputRender);
      if (!keep) turn.outputNode?.remove();
      const seconds = ((Date.now() - turn.startedAt) / 1000).toFixed(1);
      const count = turn.records.length;
      turn.node.classList.remove("live");
      if (count) {
        if (keep) {
          turn.node.classList.add("done");
          turn.title.textContent = `${count} step${count === 1 ? "" : "s"} completed · ${seconds}s`;
        } else
          turn.title.textContent = `Stopped after ${count} step${count === 1 ? "" : "s"}`;
        turn.node.open = false;
      } else turn.node.remove();
      // A completed run of tool work becomes part of the stored transcript, so
      // reopening the thread replays its steps and cards (SPEC 7.6).
      let entry = null;
      if (keep && count) {
        entry = {
          type: "activity",
          id: randomId(),
          turnId: turn.id,
          steps: turn.records,
        };
        const list = transcripts.get(turn.threadId);
        if (list) list.push(entry);
      }
      for (const step of turn.steps.values()) step.progress.hidden = true;
      currentTurn = null;
      activityNode = null;
      renderThreadList();
      return { entry, turn };
    }

    function renderOutputDelta(text) {
      const turn = currentTurn;
      if (!turn || typeof text !== "string" || !text) return;
      if (!displaying(turn.threadId)) return;
      const remaining = LIMITS.outputChars - turn.outputText.length;
      if (remaining <= 0) return;
      turn.outputText += text.slice(0, remaining);
      if (!turn.outputNode) {
        turn.outputNode = addBubble("assistant", "", { persist: false }).node;
        turn.outputNode.classList.add("streaming");
      }
      turn.label = "Answering…";
      if (turn.outputRender) return;
      turn.outputRender = requestAnimationFrame(() => {
        turn.outputRender = 0;
        if (!turn.outputNode?.isConnected) return;
        turn.outputNode.replaceChildren(renderMarkdown(turn.outputText, doc));
        scroll();
      });
    }

    function addStep(key, record) {
      const turn = currentTurn;
      const node = stepNode(record);
      turn.steps.set(key, { ...node, record });
      turn.records.push(record);
      if (displaying(turn.threadId)) {
        turn.body.append(node.card);
        scroll();
      }
      return turn.steps.get(key);
    }

    /**
     * The normalized event vocabulary both hosts emit (SPEC 10 and 14.3).
     * Unknown types are ignored so a newer host can add events safely.
     */
    function applyEvent(event) {
      const turn = currentTurn;
      if (!turn || (event.turnId && event.turnId !== turn.id)) return;
      const type = event.type;
      if (type === "model.start") {
        const label = host.modelLabel?.(event.model) ?? event.model;
        turn.label = `${event.round ? "Continuing with" : "Asking"} ${label}…`;
      } else if (type === "model.end") {
        turn.promptTokens += event.usage?.promptTokens ?? 0;
        turn.completionTokens += event.usage?.completionTokens ?? 0;
        turn.label = event.toolCalls
          ? `Running ${event.toolCalls} tool call${event.toolCalls === 1 ? "" : "s"}…`
          : "Finishing…";
        if (event.toolCalls && turn.outputNode) {
          turn.outputNode.remove();
          turn.outputNode = null;
          turn.outputText = "";
          if (turn.outputRender) {
            cancelAnimationFrame(turn.outputRender);
            turn.outputRender = 0;
          }
        }
      } else if (type === "output.delta") {
        renderOutputDelta(event.text);
      } else if (type === "tool.start") {
        addStep(event.id, {
          id: event.id,
          name: event.name,
          source: event.source ?? "site",
          status: "running",
          arguments: event.arguments ?? "",
        });
        turn.label = `Calling ${event.name}…`;
      } else if (type === "progress") {
        // Ephemeral by contract: shown, never stored, never model input.
        const step = turn.steps.get(event.toolId ?? event.id);
        if (!step) return;
        const text = String(event.text ?? "").slice(0, LIMITS.progressChars);
        step.progress.textContent = text;
        step.progress.hidden = !text;
        scroll();
      } else if (type === "tool.end") {
        const step = turn.steps.get(event.id);
        if (!step) return;
        const ok = event.ok !== false;
        step.record.status = ok ? "ok" : "error";
        step.record.result = event.result ?? "";
        step.marker.className = `marker ${ok ? "ok" : "err"}`;
        step.state.className = `state ${ok ? "ok" : "err"}`;
        step.state.textContent = ok ? "done" : "failed";
        step.progress.hidden = true;
        step.card.append(preBlock("Result", pretty(event.result)));
        if (event.card) attachCard(step, event.card);
      } else if (type === "card") {
        const step = turn.steps.get(event.toolId ?? event.id);
        if (step) attachCard(step, event.card);
      } else if (type === "card.update") {
        updateCard(event.cardId, event.card);
      } else if (type === "agent.step") {
        const key = `agent:${event.round}:${event.id || event.command}`;
        let step = turn.steps.get(key);
        if (!step) {
          step = addStep(key, {
            id: key,
            name:
              String(event.command ?? "")
                .split("\n")[0]
                .slice(0, 80) || "(command)",
            source: "agent",
            status: "running",
          });
          turn.label = `${event.provider ?? "The agent"} is running a command…`;
        }
        if (event.phase === "end") {
          const ok = event.exitCode === 0;
          step.record.status = ok ? "ok" : "error";
          step.record.result = event.output || "(no output)";
          step.marker.className = `marker ${ok ? "ok" : "err"}`;
          step.state.className = `state ${ok ? "ok" : "err"}`;
          step.state.textContent = ok
            ? "exit 0"
            : event.exitCode == null
              ? "blocked"
              : `exit ${event.exitCode}`;
          if (!step.card.querySelector("pre"))
            step.card.append(preBlock("Output", step.record.result));
        }
      } else if (type === "agent.thinking") {
        turn.label = `${event.provider ?? "The model"} is thinking (~${Number(event.tokens).toLocaleString()} tokens)…`;
      } else if (
        type === "agent.reasoning" ||
        type === "agent.reasoning.delta"
      ) {
        if (!displaying(turn.threadId)) return;
        let box = turn.reasoning;
        if (!box) {
          box = doc.createElement("details");
          box.className = "reason";
          box.open = true;
          const summary = doc.createElement("summary");
          summary.textContent = `Reasoning (${event.provider ?? "agent"})`;
          box.append(summary, doc.createElement("pre"));
          turn.body.append(box);
          turn.reasoning = box;
        }
        const pre = box.querySelector("pre");
        pre.textContent = `${pre.textContent}${type === "agent.reasoning" && pre.textContent ? "\n\n" : ""}${event.text}`;
        scroll();
      }
    }

    function attachCard(step, card) {
      if (!card) return;
      step.record.card = card;
      const node = renderCard(card, cardAction, doc);
      step.card.append(node);
      if (card.id) liveCards.set(card.id, { card, node });
      scroll();
    }

    /** Swap a card in place after a local action (SPEC 7.4). */
    function updateCard(cardId, card) {
      const live = cardId ? liveCards.get(cardId) : null;
      if (!live || !card) return false;
      const node = renderCard(card, cardAction, doc);
      live.node.replaceWith(node);
      liveCards.set(cardId, { card, node });
      for (const list of transcripts.values())
        for (const entry of list)
          if (entry.type === "activity")
            for (const step of entry.steps)
              if (step.card?.id === cardId) step.card = card;
      if (currentTurn)
        for (const step of currentTurn.steps.values())
          if (step.record.card?.id === cardId) step.record.card = card;
      return true;
    }

    async function cardAction(action, context) {
      if (action.type === "message") {
        const card = context?.cardId
          ? liveCards.get(context.cardId)?.card
          : null;
        const text = cardMessageText(action, card, context);
        await submit(text);
        return;
      }
      const replacement = await Promise.resolve(
        host.cardAction?.({
          cardId: context?.cardId ?? null,
          name: action.name,
          payload: action.payload,
          values: context?.values ?? null,
        }),
      ).catch(() => null);
      if (replacement) updateCard(context?.cardId ?? null, replacement);
    }

    // --------------------------------------------------------------- threads

    function threadsEnabled() {
      return Boolean(threadsHost);
    }

    function renderThreadList() {
      refs.threadToggle.hidden = !threadsEnabled();
      if (!threadsEnabled()) {
        refs.threadPanel.hidden = true;
        return;
      }
      refs.threadList.textContent = "";
      if (!threadSummaries.length) {
        const empty = doc.createElement("div");
        empty.className = "thread-empty";
        empty.textContent = "No saved conversations yet.";
        refs.threadList.append(empty);
        return;
      }
      for (const summary of threadSummaries) {
        const row = doc.createElement("div");
        row.className = `thread-row${summary.id === activeThreadId ? " current" : ""}`;
        const open = doc.createElement("button");
        open.type = "button";
        open.className = "thread-open";
        open.textContent = summary.title || "Untitled conversation";
        open.title = summary.title || "Untitled conversation";
        open.addEventListener("click", () => void selectThread(summary.id));
        row.append(open);
        if (currentTurn && currentTurn.threadId === summary.id) {
          const spinner = doc.createElement("span");
          spinner.className = "thread-busy";
          spinner.title = "A reply is still running here";
          row.append(spinner);
        } else row.append(doc.createElement("span"));
        if (threadsHost.rename) {
          const rename = doc.createElement("button");
          rename.type = "button";
          rename.className = "thread-act";
          rename.textContent = "✎";
          rename.title = "Rename";
          rename.setAttribute("aria-label", `Rename ${summary.title}`);
          rename.addEventListener("click", () => void renameThread(summary));
          row.append(rename);
        }
        const remove = doc.createElement("button");
        remove.type = "button";
        remove.className = "thread-act";
        remove.textContent = "🗑";
        remove.title = "Delete";
        remove.setAttribute("aria-label", `Delete ${summary.title}`);
        remove.addEventListener("click", () => void deleteThread(summary.id));
        row.append(remove);
        refs.threadList.append(row);
      }
    }

    function threadError(message) {
      refs.threadList.textContent = "";
      const node = doc.createElement("div");
      node.className = "thread-error";
      node.textContent = message;
      refs.threadList.append(node);
    }

    async function refreshThreads() {
      if (!threadsEnabled()) return;
      try {
        threadSummaries = await threadsHost.list();
        renderThreadList();
      } catch (error) {
        threadError(
          `Could not load conversations: ${error?.message ?? "unknown error"}`,
        );
      }
    }

    async function selectThread(id) {
      if (!threadsEnabled() || id === activeThreadId) return;
      // A running turn belongs to the thread that started it and keeps running
      // (SPEC 8.1); only its DOM goes away while another thread is displayed.
      let loaded;
      try {
        loaded = await threadsHost.load(id);
      } catch (error) {
        threadError(
          `Could not open that conversation: ${error?.message ?? "unknown error"}`,
        );
        return;
      }
      activeThreadId = id;
      transcripts.set(
        id,
        loaded.map((entry) =>
          entry.type === "message" ? { ...entry, source: "site" } : entry,
        ),
      );
      activityNode = null;
      renderTranscript();
      renderThreadList();
      host.threadChanged?.(id);
    }

    async function newThread() {
      if (!threadsEnabled()) return null;
      let summary;
      try {
        summary = await threadsHost.create();
      } catch (error) {
        threadError(
          `Could not start a conversation: ${error?.message ?? "unknown error"}`,
        );
        return null;
      }
      threadSummaries = [summary, ...threadSummaries];
      activeThreadId = summary.id;
      transcripts.set(summary.id, []);
      activityNode = null;
      renderTranscript();
      renderThreadList();
      host.threadChanged?.(summary.id);
      return summary;
    }

    async function renameThread(summary) {
      const title = globalThis.prompt?.("Conversation name", summary.title);
      if (title == null) return;
      try {
        await threadsHost.rename(
          summary.id,
          title.slice(0, LIMITS.threadTitle),
        );
        await refreshThreads();
      } catch (error) {
        threadError(`Could not rename: ${error?.message ?? "unknown error"}`);
      }
    }

    async function deleteThread(id) {
      try {
        await threadsHost.remove(id);
      } catch (error) {
        threadError(`Could not delete: ${error?.message ?? "unknown error"}`);
        return;
      }
      // Deleting the thread a turn is running in cancels that turn (SPEC 8.1).
      if (currentTurn?.threadId === id) host.stop?.();
      transcripts.delete(id);
      threadSummaries = threadSummaries.filter((item) => item.id !== id);
      if (activeThreadId === id) {
        activeThreadId = threadSummaries[0]?.id ?? null;
        if (activeThreadId) await selectThreadSilently(activeThreadId);
        else {
          transcripts.set(null, []);
          renderTranscript();
          host.threadChanged?.(null);
        }
      }
      renderThreadList();
    }

    async function selectThreadSilently(id) {
      try {
        const loaded = await threadsHost.load(id);
        transcripts.set(
          id,
          loaded.map((entry) =>
            entry.type === "message" ? { ...entry, source: "site" } : entry,
          ),
        );
      } catch {
        transcripts.set(id, []);
      }
      renderTranscript();
      host.threadChanged?.(id);
    }

    /** Hands the host's store the entries this turn produced (SPEC 7.6). */
    async function appendToThread(newEntries) {
      if (!threadsEnabled() || !activeThreadId || !newEntries.length) return;
      try {
        await threadsHost.append(activeThreadId, newEntries);
        await refreshThreads();
      } catch (error) {
        threadError(`Could not save: ${error?.message ?? "unknown error"}`);
      }
    }

    // -------------------------------------------------------------- composer

    function renderSuggestions() {
      refs.messages.querySelector(".welcome")?.remove();
      const list = options.suggestions ?? [];
      const empty = !entries().length;
      refs.messages.classList.toggle("empty", empty);
      if (!empty) return;
      const welcome = doc.createElement("section");
      welcome.className = "welcome";
      const title = doc.createElement("h2");
      title.textContent = `How can I help with ${options.name ?? "this site"}?`;
      welcome.append(title);
      if (options.greeting) {
        const greeting = doc.createElement("p");
        greeting.textContent = options.greeting;
        welcome.append(greeting);
      }
      if (list.length) {
        const box = doc.createElement("div");
        box.className = "suggestions";
        for (const text of list) {
          const button = doc.createElement("button");
          button.type = "button";
          button.textContent = text;
          button.addEventListener("click", () => {
            refs.input.value = text;
            refs.input.dispatchEvent(new Event("input"));
            refs.input.focus();
          });
          box.append(button);
        }
        welcome.append(box);
      }
      refs.messages.append(welcome);
    }

    function renderControls() {
      const list = options.controls ?? [];
      refs.drawer.textContent = "";
      refs.optionsButton.hidden = !list.length;
      if (!list.length) {
        refs.drawer.hidden = true;
        return;
      }
      const title = doc.createElement("h4");
      title.textContent = "Options";
      refs.drawer.append(title);
      for (const control of list) {
        const row = doc.createElement("div");
        row.className = "control";
        const text = doc.createElement("div");
        text.className = "text";
        const label = doc.createElement("span");
        label.textContent = control.label;
        text.append(label);
        if (control.description) {
          const small = doc.createElement("small");
          small.textContent = control.description;
          text.append(small);
        }
        row.append(text);
        if (control.type === "toggle") {
          const button = doc.createElement("button");
          button.type = "button";
          button.className = "switch";
          button.setAttribute("role", "switch");
          button.setAttribute(
            "aria-checked",
            String(controlValues[control.id]),
          );
          button.setAttribute("aria-label", control.label);
          button.addEventListener("click", () => {
            controlValues[control.id] = !controlValues[control.id];
            button.setAttribute(
              "aria-checked",
              String(controlValues[control.id]),
            );
            host.controlChange?.(control.id, controlValues[control.id], {
              ...controlValues,
            });
          });
          row.append(button);
        } else if (control.type === "select") {
          const select = doc.createElement("select");
          select.setAttribute("aria-label", control.label);
          for (const option of control.options) {
            const item = doc.createElement("option");
            item.value = option.value;
            item.textContent = option.label;
            item.selected = option.value === controlValues[control.id];
            select.append(item);
          }
          select.addEventListener("change", () => {
            controlValues[control.id] = select.value;
            host.controlChange?.(control.id, select.value, {
              ...controlValues,
            });
          });
          row.append(select);
        } else {
          const button = doc.createElement("button");
          button.type = "button";
          button.textContent = control.label;
          button.addEventListener("click", () =>
            host.controlChange?.(control.id, true, { ...controlValues }),
          );
          row.append(button);
        }
        refs.drawer.append(row);
      }
    }

    function renderAttachments() {
      refs.attachStrip.textContent = "";
      refs.attachStrip.hidden = !attachments.length;
      attachments.forEach((item, index) => {
        const figure = doc.createElement("figure");
        const img = doc.createElement("img");
        img.src = `data:${item.mediaType};base64,${item.data}`;
        img.alt = "Attached image";
        const remove = doc.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "Remove";
        remove.addEventListener("click", () => {
          attachments.splice(index, 1);
          renderAttachments();
        });
        figure.append(img, remove);
        refs.attachStrip.append(figure);
      });
    }

    async function addAttachment(file) {
      if (
        !IMAGE_TYPES.includes(file.type) ||
        attachments.length >= LIMITS.attachments
      )
        return;
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () =>
          resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      if (data.length > LIMITS.imageChars) {
        addBubble(
          "assistant",
          `${file.name} is too large (limit about 1.5 MB).`,
          {
            error: true,
            persist: false,
          },
        );
        return;
      }
      attachments.push({ type: "image", mediaType: file.type, data });
      renderAttachments();
    }

    function setBusy(value) {
      busy = value;
      refs.sendButton.hidden = value;
      refs.stopButton.hidden = !value;
      refs.input.disabled = value || composerBlocked;
      host.busyChanged?.(value);
      renderThreadList();
    }

    function setComposerBlocked(blocked, placeholder) {
      composerBlocked = blocked;
      refs.input.disabled = blocked || busy;
      refs.sendButton.disabled = blocked;
      refs.attachButton.disabled = blocked;
      refs.input.placeholder =
        placeholder ?? options.placeholder ?? "Ask about this site…";
    }

    async function submit(override) {
      const value =
        typeof override === "string" ? override : refs.input.value.trim();
      if ((!value && !attachments.length) || busy) return;
      if (typeof override !== "string") {
        refs.input.value = "";
        refs.input.style.height = "auto";
      }
      const content = attachments.length
        ? [...(value ? [{ type: "text", text: value }] : []), ...attachments]
        : value;
      attachments = [];
      renderAttachments();
      // A thread has to exist before the first message can be saved into it.
      if (threadsEnabled() && !activeThreadId) await newThread();
      const { entry } = addBubble("user", content);
      const produced = [entry];
      try {
        await host.submit?.(content, {
          threadId: activeThreadId,
          record(extra) {
            produced.push(extra);
          },
        });
      } finally {
        await appendToThread(produced.filter(Boolean));
      }
    }

    // ---------------------------------------------------------------- wiring

    refs.sendButton.addEventListener("click", () => void submit());
    refs.stopButton.addEventListener("click", () => host.stop?.());
    refs.closeButton.addEventListener("click", () => {
      panel.hidden = true;
      host.close?.();
    });
    refs.clearButton.addEventListener("click", () => {
      host.reset?.();
      transcripts.set(activeThreadId, []);
      activityNode = null;
      renderTranscript();
    });
    refs.optionsButton.addEventListener("click", (event) => {
      refs.drawer.hidden = !refs.drawer.hidden;
      event.currentTarget.setAttribute(
        "aria-pressed",
        String(!refs.drawer.hidden),
      );
    });
    refs.threadToggle.addEventListener("click", (event) => {
      refs.threadPanel.hidden = !refs.threadPanel.hidden;
      event.currentTarget.setAttribute(
        "aria-pressed",
        String(!refs.threadPanel.hidden),
      );
      if (!refs.threadPanel.hidden) void refreshThreads();
    });
    refs.threadNew.addEventListener("click", () => void newThread());
    refs.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    });
    refs.input.addEventListener("input", () => {
      refs.input.style.height = "auto";
      refs.input.style.height = `${Math.min(refs.input.scrollHeight, 140)}px`;
    });
    refs.attachButton.addEventListener("click", () => refs.fileInput.click());
    refs.fileInput.addEventListener("change", async () => {
      for (const file of refs.fileInput.files) await addAttachment(file);
      refs.fileInput.value = "";
    });
    refs.input.addEventListener("paste", async (event) => {
      const files = [...(event.clipboardData?.files ?? [])].filter((file) =>
        IMAGE_TYPES.includes(file.type),
      );
      if (files.length && !refs.attachButton.hidden) {
        event.preventDefault();
        for (const file of files) await addAttachment(file);
      }
    });
    enableDrag(refs.head, panel);

    function setOptions(next) {
      options = { ...options, ...next };
      refs.name.textContent = options.name || "AI assistant";
      panel.dataset.mode = options.theme?.mode ?? "light";
      panel.dataset.toolView = options.toolCallView ?? "compact";
      if (!composerBlocked)
        refs.input.placeholder = options.placeholder || "Ask about this site…";
      controlValues = defaultControls(options.controls, controlValues);
      renderControls();
      renderSuggestions();
      renderThreadList();
    }

    function defaultControls(list, existing = {}) {
      const values = {};
      for (const control of list ?? [])
        if (control.type !== "button")
          values[control.id] = Object.hasOwn(existing, control.id)
            ? existing[control.id]
            : control.default;
      return values;
    }

    setOptions({});

    return {
      panel,
      refs,
      style: STYLE,
      // transcript
      addBubble,
      addAssistantResult,
      renderTranscript,
      modelHistory,
      entries: () => entries().slice(),
      clear() {
        transcripts.set(activeThreadId, []);
        renderTranscript();
      },
      // activity
      startActivity,
      applyEvent,
      finishActivity,
      currentTurn: () => currentTurn,
      // cards
      updateCard,
      // threads
      setThreadHost(next) {
        threadsHost = next ?? null;
        if (!threadsHost) {
          activeThreadId = null;
          threadSummaries = [];
          refs.threadPanel.hidden = true;
        }
        renderThreadList();
      },
      refreshThreads,
      newThread,
      selectThread,
      activeThread: () => activeThreadId,
      // composer
      submit,
      setBusy,
      isBusy: () => busy,
      setComposerBlocked,
      setAttachmentsEnabled(enabled) {
        refs.attachButton.hidden = !enabled;
        if (!enabled) {
          attachments = [];
          renderAttachments();
        }
      },
      attachments: () => attachments.slice(),
      // options and controls
      setOptions,
      controls: () => ({ ...controlValues }),
      setControls(values) {
        controlValues = { ...controlValues, ...values };
        renderControls();
        return { ...controlValues };
      },
      renderSuggestions,
    };
  }

  /** Move the panel by its header; resizing keeps using the CSS handle. */
  function enableDrag(handle, panel) {
    let start = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      start = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener("pointermove", (event) => {
      if (!start) return;
      const rect = panel.getBoundingClientRect();
      const left = Math.min(
        Math.max(0, event.clientX - start.x),
        window.innerWidth - rect.width,
      );
      const top = Math.min(
        Math.max(0, event.clientY - start.y),
        window.innerHeight - rect.height,
      );
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
    });
    const stop = () => {
      start = null;
    };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  return {
    STYLE,
    IMAGE_TYPES,
    LIMITS,
    build,
    renderMarkdown,
    appendMarkdownInline,
    renderCard,
    cardMessageText,
    createChatView,
    enableDrag,
    pretty,
  };
})();
