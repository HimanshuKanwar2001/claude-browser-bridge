chrome.runtime.sendMessage({ type: "status" }, (res) => {
  const dot = document.getElementById("dot");
  const text = document.getElementById("status-text");
  const box = document.getElementById("status");
  if (res?.connected) {
    dot.className = "dot on";
    text.textContent = "Connected to Claude Code";
    box.className = "status connected";
  } else {
    dot.className = "dot off";
    text.textContent = "Not connected — is Claude Code running?";
    box.className = "status disconnected";
  }
});
