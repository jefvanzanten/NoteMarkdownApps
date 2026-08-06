import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import {
  collectChecklistItems,
  collectBulletListItems,
  horizontalRulePattern,
  startTaskDrag,
} from "./dragDrop";

class DragHandleWidget extends WidgetType {
  constructor(readonly lineFrom: number) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "cm-task-handle";
    handle.tabIndex = -1;
    handle.title = "Sleep om item te verplaatsen";
    handle.setAttribute("aria-label", "Sleep om item te verplaatsen");
    handle.addEventListener("pointerdown", (event) => {
      startTaskDrag(view, event, this.lineFrom);
    });
    return handle;
  }

  eq(other: DragHandleWidget): boolean {
    return other.lineFrom === this.lineFrom;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly from: number,
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement("input");
    el.type = "checkbox";
    el.checked = this.checked;
    el.className = "cm-checkbox";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({
        changes: {
          from: this.from,
          to: this.from + 3,
          insert: this.checked ? "[ ]" : "[x]",
        },
      });
    });
    return el;
  }

  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked && other.from === this.from;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class BulletWidget extends WidgetType {
  constructor(
    readonly bullet: string,
    readonly lineFrom: number,
  ) {
    super();
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement("span");
    container.className = "cm-bullet-container";

    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "cm-task-handle";
    handle.tabIndex = -1;
    handle.title = "Sleep om lijst-item te verplaatsen";
    handle.setAttribute("aria-label", "Sleep om lijst-item te verplaatsen");
    handle.addEventListener("pointerdown", (event) => {
      startTaskDrag(view, event, this.lineFrom);
    });

    const bulletSpan = document.createElement("span");
    bulletSpan.className = "cm-bullet-text";
    bulletSpan.textContent = this.bullet;

    container.appendChild(handle);
    container.appendChild(bulletSpan);
    return container;
  }

  eq(other: BulletWidget): boolean {
    return other.bullet === this.bullet && other.lineFrom === this.lineFrom;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export const mdPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }

    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged) {
        this.decorations = this.build(u.view);
      }
    }

    build(view: EditorView): DecorationSet {
      const decs: Range<Decoration>[] = [];
      const checklistByLine = new Map(
        collectChecklistItems(view.state).map((item) => [item.lineFrom, item]),
      );
      const bulletListByLine = new Map(
        collectBulletListItems(view.state).map((item) => [item.lineFrom, item]),
      );
      const activeLine = view.hasFocus
        ? view.state.doc.lineAt(view.state.selection.main.head).number
        : -1;
      const tree = syntaxTree(view.state);
      let fenceMarker: "```" | "~~~" | null = null;

      for (let ln = 1; ln <= view.state.doc.lines; ln++) {
        const line = view.state.doc.line(ln);
        const fenceMatch = line.text.match(/^(```|~~~)(\S+)?\s*$/);
        const isFenceLine = Boolean(fenceMatch);
        const opensFence = Boolean(fenceMatch && fenceMarker === null);
        const closesFence = Boolean(fenceMatch && fenceMarker === fenceMatch[1]);
        const inFenceBlock = fenceMarker !== null || opensFence;

        if (horizontalRulePattern.test(line.text) && ln !== activeLine) {
          decs.push(Decoration.line({ class: "md-hr" }).range(line.from));
        }

        const hm = line.text.match(/^(#{1,6}) /);
        if (hm) {
          decs.push(Decoration.line({ class: `md-h${hm[1].length}` }).range(line.from));
          if (ln !== activeLine) {
            decs.push(Decoration.replace({}).range(line.from, line.from + hm[0].length));
          }
        }

        if (inFenceBlock) {
          decs.push(
            Decoration.line({
              class: isFenceLine ? "md-codeblock-fence" : "md-codeblock-line",
            }).range(line.from),
          );
        }

        if (opensFence && fenceMatch && ln !== activeLine) {
          decs.push(
            Decoration.replace({}).range(line.from, line.from + fenceMatch[0].trimEnd().length),
          );
        }

        const checklistItem = checklistByLine.get(line.from);
        if (checklistItem) {
          decs.push(
            Decoration.widget({
              widget: new DragHandleWidget(checklistItem.lineFrom),
              side: -1,
            }).range(checklistItem.handleFrom),
          );
          decs.push(
            Decoration.replace({
              widget: new CheckboxWidget(checklistItem.checked, checklistItem.checkboxFrom),
            }).range(checklistItem.checkboxFrom, checklistItem.checkboxFrom + 3),
          );
        }

        const bulletListItem = bulletListByLine.get(line.from);
        if (bulletListItem) {
          decs.push(
            Decoration.replace({
              widget: new BulletWidget(bulletListItem.bullet, bulletListItem.lineFrom),
            }).range(bulletListItem.bulletFrom, bulletListItem.bulletFrom + bulletListItem.bullet.length),
          );
        }

        if (ln !== activeLine) {
          tree.iterate({
            from: line.from,
            to: line.to,
            enter(node) {
              if (
                node.name === "EmphasisMark" ||
                node.name === "CodeMark" ||
                node.name === "StrikethroughMark"
              ) {
                decs.push(Decoration.replace({}).range(node.from, node.to));
              }
            },
          });
        }

        if (opensFence) {
          fenceMarker = fenceMatch?.[1] as "```" | "~~~";
        } else if (closesFence) {
          fenceMarker = null;
        }
      }

      return Decoration.set(decs);
    }
  },
  { decorations: (v) => v.decorations },
);
