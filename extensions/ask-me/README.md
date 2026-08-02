# ask-me

`ask_me` is an interactive tool the LLM can use whenever it needs user input, clarification, a choice, an interview, or confirmation.

## Question types

- `question` — free-form multiline answer
- `selection` — one option, optionally with a custom answer
- `confirmation` — yes or no
- Multiple mixed questions are displayed as a `questionnaire`.

Each question can include decision context and a recommendation with a reason. In the TUI, **Ctrl+R** applies a recommendation only when the question has no answer. It never submits automatically or overwrites an answer.

## Conversation display

While active, the tool uses a compact status row:

```text
ask-me · questionnaire · ◌ creating
ask-me · questionnaire · ? waiting
```

After completion, cancellation, or failure, the status updates and the complete result remains visible:

```text
ask-me · questionnaire · ✓ done

The user submitted 2 answers for 2 questions:

Q1. Which database should the project use?
A1. PostgreSQL

Q2. Should migrations run during deployment?
A2. Yes
```

Cancellation retains partial answers and explicitly marks unanswered questions. The same transcript is returned to the LLM.

## TUI controls

- **Enter / Tab** — save and open the next question
- **Shift+Tab** — previous question
- **Arrow keys** — move through selection options
- **Shift+Enter** — newline in a text answer
- **Ctrl+R** — use the recommendation when unanswered
- **Esc** — return from custom input or cancel the questionnaire

Multiple questions end on a review screen before submission.

## Other modes

RPC mode uses Pi's abort-aware standard input and selection dialogs. Recommendations are displayed, but multiline editing, previous-question navigation, and the TUI-only Ctrl+R shortcut are unavailable. JSON and print modes report that interactive input is unavailable.
