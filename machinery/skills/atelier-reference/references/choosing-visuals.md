# Choose a visual around a question

Before composing JSON, finish this sentence: “The reader should be able to
see ___.” State the answer in the surrounding prose. A visual earns its place
by making a comparison, relationship or change easier to inspect. One answer,
one visual. A valid payload is not proof of a useful explanation.

## Selection

| Reader's question | Choose | Avoid / fallback |
|---|---|---|
| What is the answer to one fact? | Prose | A metric card for one number |
| What are the few headline measures? | `metrics`, usually 2–4 values | Unrelated numbers without units or time window |
| Which category is larger? | `chart` / `bar`; sort by value unless order has meaning | A line connecting unordered categories |
| How did a measure change over time? | `chart` / `line`, chronological, equally spaced observations | Irregular dates: this renderer spaces labels equally; use a table or an exported scientific plot |
| What are the exact differences between options? | `table` with common columns and units | A chart of incomparable units or qualitative scores invented by the agent |
| How much of a known total is complete? | `progress` with a real `max` | An estimated percentage with no denominator |
| What happened, or comes next? | `timeline` | Playback of a simple list |
| How does one thing cause, send or depend on another? | `explainer` / `flow` | Arrows that merely mean “mentioned next” |
| Who sends what to whom, in what order? | `explainer` / `sequence`; nodes are actors, edges are messages in order | Nodes that are events such as “disconnect” and “reconnect”; use timeline for those |
| What returns to its starting state, and why? | `explainer` / `cycle`; include the actual return edge and its condition | A loop around a process that ends |
| Which boundary does an operation cross? | `explainer` / `layers`; name the layers and crossings | Implying containment from a plain stack; use Mermaid for actual nesting |
| What does the whole dependency graph look like? | Mermaid for a compact graph; `flow` artifact for a larger graph | Twelve tiny cards and twenty crossings squeezed into a chat |
| Where does a particular object move or change state? | `scene` artifact with stable object IDs and named states | Decorative pulses, spins or particles without meaning |
| How does a numeric parameter change computed pixels or buffers? | `render` artifact; compare outputs at the same frame and pixel | Painted approximations presented as computed output; read `references/rendering-models.md` |
| Would this interaction work? | `mockup` artifact | Using a mockup for a production implementation |
| What did the running UI do? | Image, compare, or video proof | A synthetic diagram presented as observed evidence |

Read `references/visual-artifacts.md` before writing an artifact. When a
question needs a distribution, correlation, uncertainty interval, geographic
map or publication-quality plot, generate a standalone plot with standard
plotting tools. Do not squeeze it into the bar/line schema or invent fields.

## Composition

1. Identify the reader, question, takeaway and evidence. Separate measured
   values from illustrative data. Mark an example as illustrative in its title
   or surrounding prose. Never invent data to make a real result look complete.
2. Choose the representation from the table. Start with 3–6 categories or
   nodes, 1–2 series, and 3–5 steps. These are readability targets, not schema
   limits. Split a crowded explanation into separate questions.
3. Use a title stating the finding, and put units and time window in the title
   or series names. State sources, missing observations and uncertainty beside
   the visual; the schema does not have arbitrary `source` or `unit` fields.
4. Keep names short and recognizable. IDs are internal references; labels are
   what people read. Name edges with verbs or conditions. Preserve both ends
   of every relationship. Color may reinforce a label, never replace it.
5. For an explainer, write the narration first. Each step should explain one
   change, name the relevant actors, and say why it matters. `active` highlights
   nodes, not individual edges: it cannot distinguish two different messages
   between the same actors. Use separate explainers or a scene when that
   distinction is essential. Do not imply measured timing from playback speed.
6. Use motion only when the transition carries information. Keep the starting
   and ending states understandable while paused. Never make the reader wait
   for an animation to learn the answer. Prefer simultaneous bars or a table
   when the task is comparing values across states.
7. Validate through the presenter, then inspect the rendered result. Check a
   narrow chat, long labels, all steps and reduced motion. Can someone answer
   the original question from the paused visual without reading the JSON?
   If not, simplify or use prose/table. Do not call validation a usability test.

## Worked examples

These are illustrative, renderer-valid inputs. Submit the JSON through
`atelier tool present widget --input FILE`; do not paste fences into chat.

### Comparing categories

Question: which path benefits from caching? Choose bars because the paths are
categories. A negative value is a reduction, and every value uses milliseconds.
Keep the explanation “Caching reduced response time by 40 ms” beside the chart.

```json
{"type":"chart","chart":"bar","title":"Illustrative response-time change (ms)","series":[{"name":"Change (ms)"}],"data":[{"label":"Cached","values":[-40]},{"label":"Uncached","values":[20]},{"label":"Unchanged","values":[0]}]}
```

### Explaining messages

Question: how does the browser recover missed events? Actors stay fixed;
messages are ordered. The final state is live delivery, not an endless retry.

```json
{"type":"explainer","layout":"sequence","title":"Recovery sends only missed events","summary":"Illustrative protocol: the browser supplies its last event number.","nodes":[{"id":"browser","label":"Browser"},{"id":"server","label":"Server"},{"id":"log","label":"Event log"}],"edges":[{"from":"browser","to":"server","label":"Resume after event 42"},{"from":"server","to":"log","label":"Read events after 42"},{"from":"log","to":"server","label":"Return missed events"},{"from":"server","to":"browser","label":"Replay, then stream live"}],"steps":[{"label":"Browser reconnects","detail":"Its last event number tells the server where to resume.","active":["browser"]},{"label":"Server reads the gap","detail":"The event log supplies only events the browser has not seen.","active":["server","log"]},{"label":"Browser returns to live delivery","detail":"Replay fills the gap before new events arrive.","active":["browser","server"]}]}
```

### Explaining a feedback loop

Question: why does a failed request run again? The return edge names the
condition. Success exits the loop; the narration says so explicitly.

```json
{"type":"explainer","layout":"cycle","title":"Retries wait before another attempt","summary":"Illustrative retry policy. Success exits; failure waits before retrying.","nodes":[{"id":"attempt","label":"Send request"},{"id":"check","label":"Check response"},{"id":"wait","label":"Wait"}],"edges":[{"from":"attempt","to":"check","label":"Response arrives"},{"from":"check","to":"wait","label":"Temporary failure"},{"from":"wait","to":"attempt","label":"Delay expires"}],"steps":[{"label":"Send and check","detail":"A successful response finishes the operation.","active":["attempt","check"]},{"label":"Wait after a temporary failure","detail":"The delay prevents immediate repeated requests.","active":["wait"]},{"label":"Try again after the delay","detail":"Only the retry path returns to the start.","active":["wait","attempt"]}]}
```

## Evidence behind the guidance

- [ONS visualisation principles](https://service-manual.ons.gov.uk/data-visualisation/guidance/principles): choose the important comparison, reduce clutter and support the finding with chart text.
- [NSW chart selection](https://designsystem.nsw.gov.au/methods/charts-and-graphs.html): match chart type to the relationship, with explicit summaries, units and tabular data.
- [Heer and Robertson, 2007](https://idl.uw.edu/papers/animated-transitions): appropriately designed transitions can improve graphical perception. This supports stable identities and staged changes, not arbitrary motion.
- [Robertson et al., 2008](https://pubmed.ncbi.nlm.nih.gov/18988980/): in their trend tasks, static views were faster for analysis and small multiples more accurate; animation produced errors even when participants enjoyed it. This does not establish that all animation is harmful.
- [W3C pause, stop, hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html): readers need control over qualifying automatic motion. Atelier should also preserve comprehension without motion.

The selection rules and readability targets above are product recommendations
informed by these sources, not experimentally validated thresholds. Evaluate
agent output by whether a reader answers the intended question correctly,
not by how many widgets were emitted.
