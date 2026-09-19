const status = document.querySelector("#status");
const statusDot = document.querySelector("#status-dot");
const hint = document.querySelector("#hint");
const openButton = document.querySelector("#open-assistant");

let registration;
let starting = false;

function showState(message, state = "waiting", detail = "") {
  status.textContent = message;
  statusDot.className = `status-dot ${state === "waiting" ? "" : state}`;
  hint.textContent = detail;
}

async function registerAssistant() {
  if (starting || registration) return;
  if (!window.ai?.arjunah?.site?.register) {
    showState(
      "Extension not detected",
      "error",
      "Load or reload the extension, then refresh this page.",
    );
    return;
  }

  starting = true;
  showState("Registering assistant…");
  try {
    registration = await window.ai.arjunah.site.register({
      name: "Protocol Lab Assistant",
      description: "A small assistant for testing the अर्जुनः extension.",
      systemPrompt:
        "You are the assistant for a minimal protocol test page. Be brief. When asked whether the sample is ready, call get_sample_status and report its result.",
      widget: {
        autoShow: false,
        greeting:
          "The sample assistant is connected. What would you like to test?",
        placeholder: "Ask about the sample page…",
        suggestions: [
          "Use the site tool and tell me whether the sample is ready.",
          "Summarise what this page is for in one sentence.",
        ],
        theme: { accent: "#3b5bdb", mode: "auto" },
        controls: [
          {
            id: "detail",
            type: "select",
            label: "Answer detail",
            description: "How much the assistant should say",
            options: [
              { value: "brief", label: "Brief" },
              { value: "full", label: "Full" },
            ],
            default: "brief",
          },
          {
            id: "timestamps",
            type: "toggle",
            label: "Include timestamps",
            description: "Return checkedAt from the site tool",
            default: true,
            model: false,
          },
        ],
      },
      onControlChange(id, value) {
        hint.textContent = `Widget option ${id} is now ${String(value)}.`;
      },
      tools: [
        {
          name: "get_sample_status",
          description:
            "Return the current readiness state of this sample page.",
          inputSchema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          handler: async (_args, invocation) => ({
            ready: true,
            page: "Assistant Protocol Lab",
            ...(invocation.controls?.timestamps === false
              ? {}
              : { checkedAt: new Date().toISOString() }),
          }),
        },
      ],
    });
    openButton.disabled = false;
    showState(
      "Assistant registered",
      "ready",
      `Protocol ${window.ai.arjunah.version} is ready.`,
    );
  } catch (error) {
    showState(
      "Registration failed",
      "error",
      error?.message || "Reload the extension and this page, then try again.",
    );
  } finally {
    starting = false;
  }
}

openButton.addEventListener("click", async () => {
  openButton.disabled = true;
  try {
    await window.ai.arjunah.chat.open();
    showState(
      "Assistant opened",
      "ready",
      "Send the suggested prompt in chat.",
    );
  } catch (error) {
    showState(
      "Could not open assistant",
      "error",
      error?.message || "Try reloading the page.",
    );
  } finally {
    openButton.disabled = !registration;
  }
});

if (window.ai?.arjunah) {
  registerAssistant();
} else {
  window.addEventListener("arjunah:ready", registerAssistant, {
    once: true,
  });
  window.setTimeout(registerAssistant, 1200);
}
