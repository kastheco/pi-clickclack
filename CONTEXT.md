# ClickClack Pi Bridge

This context describes how ClickClack conversations are connected to persistent Pi coding-agent sessions without coupling either upstream system to the integration.

## Language

**Bridge**:
The standalone `clickclack-pi` service that translates between ClickClack conversation events and Pi session operations.
_Avoid_: Plugin, Pi extension, ClickClack fork feature

**Conversation**:
A ClickClack channel or direct conversation that may be bound to one Pi session.
_Avoid_: Room, chat session

**Binding**:
The durable association between a ClickClack conversation, a project alias, and a Pi session.
_Avoid_: Route, pin

**Project alias**:
A configured name for an approved local working directory available to bindings.
_Avoid_: Path, repository name

**Turn**:
One active Pi response cycle associated with one ClickClack invocation and one ClickClack `turn_id`.
_Avoid_: Job, request

**Invocation**:
An owner-authored ClickClack message accepted by the bridge as input to a Pi session.
_Avoid_: Command, event

**Activity**:
Sanitized Pi commentary and tool execution retained in ClickClack alongside a turn without becoming its final answer.
_Avoid_: Thinking, logs

**Interactive request**:
A blocking Pi request for confirmation, selection, or owner input that the bridge resolves through a correlated ClickClack reply.
_Avoid_: Prompt, approval when referring to every request type
