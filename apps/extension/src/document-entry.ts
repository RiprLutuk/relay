type DocumentModel = { toString(): string; length: number };
type EditorView = { state?: { doc?: DocumentModel }; viewState?: { state?: { doc?: DocumentModel } } };
type EditorNode = HTMLElement & { cmTile?: { view?: EditorView }; cmView?: { view?: EditorView } };

function publishDocumentSnapshots(): void {
  for (const node of document.querySelectorAll<EditorNode>(".cm-content")) {
    try {
      const view = node.cmTile?.view || node.cmView?.view;
      const model = view?.state?.doc || view?.viewState?.state?.doc;
      if (!model || model.length > 262144) continue;
      const text = model.toString();
      if (node.getAttribute("data-relay-code") !== text) node.setAttribute("data-relay-code", text);
    } catch {}
  }
}

document.addEventListener("relay:refresh-code", publishDocumentSnapshots);
setInterval(publishDocumentSnapshots, 1000);
