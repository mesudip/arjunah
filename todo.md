# TODO

- [ ] **Secure inputs for Host Control's अर्जुनः model path.** Passwords and SSH key passphrases are excluded from model-visible schemas and rejected in tool arguments, but the CBOR chat does not yet provide a secure collection flow. Add a backend `secure_input_required` event, show a masked one-time prompt in Host Control, return the value directly to the pending operation (never the transcript/model/logs), then retry it with cancellation, timeout, redaction, and regression tests.
