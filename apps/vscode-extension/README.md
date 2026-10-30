# Relay Workspace

Use a web AI conversation to inspect, edit and run checks in a selected local project.

This VSIX includes the Rust runtime and browser companion. Open a local project folder you trust; Relay starts automatically.

[Complete setup](https://github.com/RiprLutuk/relay#setup) · [Downloads](https://github.com/RiprLutuk/relay/releases/latest)

## First use

Open the Command Palette with **Ctrl+Shift+P**, or **Cmd+Shift+P** on macOS.

1. Run **Relay: Open Browser Extensions** to reveal the browser companion folder.
2. In Chrome, Brave or Edge's extensions page, enable **Developer mode**, click **Load unpacked** and select that folder. Pin Relay to the toolbar.
3. Run **Relay: Copy Pairing Token** in the editor. In the browser's Relay popup, paste into **Pairing token from your editor** and click **Pair editor**.
4. Open a Claude or ChatGPT conversation and its Relay popup. Select **Project**, choose **Access for this conversation** and click **Start session**. Full access requires checking its approval box.

Type your task in chat normally. Try: **“List the main folders in this project and explain what it does.”**

## Controls

**Ready** in the popup confirms the connection. Start a session to enable agent actions. Use **Stop session** before changing projects. Each conversation keeps its chosen root across editor focus changes.

Click **Relay in the editor status bar** for setup and activity, or run **Relay: Open Control Center**. Browser installation and pairing are one-time steps. The bundled package starts automatically; binary overrides are available for advanced installations.

## Updates

After installing a VSIX, run **Developer: Reload Window** and reopen this details tab. Reload Relay in your browser's extensions page, refresh the chat and start a new session. If you still see 4.0.6, install the v1 VSIX manually and confirm replacement; the version sequence was reset.

[Project](https://github.com/RiprLutuk/relay) · [Provenance](https://github.com/RiprLutuk/relay/blob/main/PROVENANCE.md)
