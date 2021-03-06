import {ViewPlugin, PluginValue, ViewUpdate, EditorView} from "../../view"
import {combineConfig, Annotation, EditorSelection, EditorState,
        Transaction, Extension, StateField, Facet, Precedence} from "../../state"
import {keymap} from "../../keymap"
import {Tooltip, tooltips, showTooltip} from "../../tooltip"

export enum FilterType { Start, Fuzzy }

export class AutocompleteContext {
  constructor(readonly explicit: boolean,
              readonly filterType: FilterType) {}

  filter(completion: string, text: string) {
    if (this.filterType == FilterType.Start)
      return completion.length > text.length && completion.slice(0, text.length) == text
    else
      return completion.length > text.length && completion.indexOf(text) > -1
  }
}

export type Autocompleter =
  (state: EditorState, pos: number, context: AutocompleteContext) => readonly Completion[] | Promise<readonly Completion[]>

export interface AutocompleteConfig {
  override: Autocompleter | null
  filterType: FilterType
}

export interface Completion {
  label: string,
  start: number,
  end: number,
  apply?: string | ((view: EditorView) => void)
}

// FIXME appending multiple providers is probably not a great default
function retrieveCompletions(state: EditorState, pos: number, context: AutocompleteContext): Promise<readonly Completion[]> {
  let found = state.languageDataAt<Autocompleter>("autocomplete", pos)
    .map(compl => Promise.resolve(compl(state, pos, context)))
  return found.length == 1 ? found[0] : found.length == 0 ? Promise.resolve([]) :
    Promise.all(found).then(results => results.reduce((list, items) => list.concat(items), [] as Completion[]))
}

const autocompleteConfig = Facet.define<Partial<AutocompleteConfig>, AutocompleteConfig>({
  combine(configs) {
    return combineConfig(configs, {
      override: null,
      filterType: FilterType.Start
    })
  }
})

export function autocomplete(config: Partial<AutocompleteConfig> = {}): Extension {
  return [
    activeCompletion,
    autocompleteConfig.of(config),
    autocompletePlugin,
    style,
    tooltips(),
    Precedence.Override.set(keymap({
      ArrowDown: moveCompletion("down"),
      ArrowUp: moveCompletion("up"),
      Enter: acceptCompletion,
      Escape: closeCompletion
    }))
  ]
}

function moveCompletion(dir: string) {
  return (view: EditorView) => {
    let active = view.state.field(activeCompletion)
    if (!(active instanceof ActiveCompletion)) return false
    let selected = (active.selected + (dir == "up" ? active.options.length - 1 : 1)) % active.options.length
    view.dispatch(view.state.t().annotate(setActiveCompletion,
                                          new ActiveCompletion(active.options, selected, active.id, active.tooltip)))
    return true
  }
}

function acceptCompletion(view: EditorView) {
  let active = view.state.field(activeCompletion)
  if (!(active instanceof ActiveCompletion)) return false
  applyCompletion(view, active.options[active.selected])
  return true
}

export function startCompletion(view: EditorView) {
  let active = view.state.field(activeCompletion)
  if (active != null && active != "pending") return false
  view.dispatch(view.state.t().annotate(setActiveCompletion, "pendingExplicit"))
  return true
}

function applyCompletion(view: EditorView, option: Completion) {
  let apply = option.apply || option.label
  // FIXME make sure option.start/end still point at the current
  // doc, or keep a mapping in an active completion
  if (typeof apply == "string") {
    view.dispatch(view.state.t().replace(option.start, option.end, apply)
                  .setSelection(EditorSelection.single(option.start + apply.length)))
  } else {
    apply(view)
  }
}

function closeCompletion(view: EditorView) {
  let active = view.state.field(activeCompletion)
  if (active == null) return false
  view.dispatch(view.state.t().annotate(setActiveCompletion, null))
  return true
}

type ActiveState = ActiveCompletion // There is a completion active
  | null // No completion active
  | "pending" // Must update after user input
  | "pendingExplicit" // Must update after explicit completion command

const setActiveCompletion = Annotation.define<ActiveState>()

const activeCompletion = StateField.define<ActiveState>({
  create() { return null },
  update(prev, tr) {
    let set = tr.annotation(setActiveCompletion)
    if (set !== undefined) return set

    return tr.annotation(Transaction.userEvent) == "input" ? "pending"
      : tr.docChanged || tr.selectionSet ? null
      : prev
  }
}).provideN(showTooltip, active => active instanceof ActiveCompletion ? active.tooltip : none)
  .provide(EditorView.contentAttributes, active => active instanceof ActiveCompletion ? active.attrs : baseAttrs)

const baseAttrs = {"aria-autocomplete": "list"}, none: readonly any[] = []

class ActiveCompletion {
  readonly attrs = {
    "aria-autocomplete": "list",
    "aria-activedescendant": this.id + "-" + this.selected,
    "aria-owns": this.id
  }

  constructor(readonly options: readonly Completion[],
              readonly selected: number,
              readonly id = "cm-ac-" + Math.floor(Math.random() * 1679616).toString(36),
              readonly tooltip = [completionTooltip()]) {}
}

function createListBox(completion: ActiveCompletion) {
  const ul = document.createElement("ul")
  ul.id = completion.id
  ul.setAttribute("role", "listbox")
  ul.setAttribute("aria-expanded", "true")
  for (let i = 0; i < completion.options.length; i++) {
    const li = ul.appendChild(document.createElement("li"))
    li.id = completion.id + "-" + i
    li.innerText = completion.options[i].label
    li.setAttribute("role", "option")
  }
  return ul
}

// We allocate a new function instance every time the completion
// changes to force redrawing/repositioning of the tooltip
function completionTooltip() {
  return (view: EditorView): Tooltip => {
    let active = view.state.field(activeCompletion) as ActiveCompletion
    let list = createListBox(active)
    list.addEventListener("click", (e: MouseEvent) => {
      let index = 0, dom = e.target as HTMLElement | null
      for (;;) { dom = dom!.previousSibling as (HTMLElement | null); if (!dom) break; index++ }
      let active = view.state.field(activeCompletion)
      if (active instanceof ActiveCompletion && index < active.options.length)
        applyCompletion(view, active.options[index])
    })
    function updateSel(view: EditorView) {
      let cur = view.state.field(activeCompletion)
      if (cur instanceof ActiveCompletion) updateSelectedOption(list, cur.selected)
    }
    return {
      dom: list,
      mount: updateSel,
      update(update: ViewUpdate) {
        if (update.state.field(activeCompletion) != update.prevState.field(activeCompletion))
          updateSel(update.view)
      },
      pos: active.options.reduce((m, o) => Math.min(m, o.start), 1e9),
      style: "autocomplete"
    }
  }
}

function updateSelectedOption(list: HTMLElement, selected: number) {
  let set: null | HTMLElement = null
  for (let opt = list.firstChild as (HTMLElement | null), i = 0; opt;
       opt = opt.nextSibling as (HTMLElement | null), i++) {
    if (i == selected) {
      if (!opt.hasAttribute("aria-selected")) {
        opt.setAttribute("aria-selected", "true")
        set = opt
      }
    } else {
      if (opt.hasAttribute("aria-selected")) opt.removeAttribute("aria-selected")
    }
  }
  if (set) scrollIntoView(list, set)
}

function scrollIntoView(container: HTMLElement, element: HTMLElement) {
  let parent = container.getBoundingClientRect()
  let self = element.getBoundingClientRect()
  if (self.top < parent.top) container.scrollTop -= parent.top - self.top
  else if (self.bottom > parent.bottom) container.scrollTop += self.bottom - parent.bottom
}

const DebounceTime = 100

const autocompletePlugin = ViewPlugin.fromClass(class implements PluginValue {
  stateVersion = 0
  debounce = -1

  constructor(readonly view: EditorView) {}

  update(update: ViewUpdate) {
    if (!(update.docChanged || update.selectionSet ||
          update.transactions.some(t => t.annotation(setActiveCompletion) !== undefined))) return
    this.stateVersion++
    if (this.debounce > -1) clearTimeout(this.debounce)
    let active = update.state.field(activeCompletion)
    this.debounce = active == "pending" || active == "pendingExplicit"
      ? setTimeout(() => this.startUpdate(active == "pendingExplicit"), DebounceTime) : -1
  }

  startUpdate(explicit: boolean) {
    this.debounce = -1
    let version = this.stateVersion, state = this.view.state, pos = state.selection.primary.head
    let config = state.facet(autocompleteConfig)
    let context = new AutocompleteContext(explicit, config.filterType)
    ;(config.override ? Promise.resolve(config.override(state, pos, context)) : retrieveCompletions(state, pos, context))
      .then(result => {
        if (this.stateVersion != version || result.length == 0) return
        this.view.dispatch(this.view.state.t().annotate(setActiveCompletion, new ActiveCompletion(result, 0)))
      })
  }
})

const style = Precedence.Fallback.set(EditorView.theme({
  "tooltip.autocomplete": {
    fontFamily: "monospace",
    overflowY: "auto",
    maxHeight: "10em",
    listStyle: "none",
    margin: 0,
    padding: 0,

    "& > li": {
      cursor: "pointer",
      padding: "1px 1em 1px 3px"
    },

    "& > li[aria-selected]": {
      background_fallback: "#bdf",
      background: "Highlight",
      color_fallback: "white",
      color: "HighlightText"
    }
  }
}))
