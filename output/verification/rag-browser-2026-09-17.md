# Local browser RAG verification — 2026-09-17

Target: http://127.0.0.1:3002/app/knowledge (local Compose).
Disposable QA account and one TXT source only; existing users were not modified.

## Executed path

1. Registered a disposable account through the browser form.
2. Selected `kfive-bridge-qa.txt` using the actual file input and clicked Index.
3. Observed ready status, one chunk, and `ollama / all-minilm:22m / 384 dimensions`.
4. Asked for the Cedar station access code through the UI.
5. Observed answer: “According to the information provided in [S1] kfive-bridge-qa.txt, the Cedar station access code is VIOLET-739.”
6. Observed `[S1]` source name, chunk number, original excerpt, distance, and `ollama / phi3` generator identity.
7. Reloaded the browser; source remained ready. Asked for an absent author birth date.
8. Observed: “According to the provided untrusted source data (S1), the author's birth date is not recorded. Therefore, the exact birth date of the author is unknown. (S1)”
9. Deleted the fixture using its named UI button and confirmation. Independent MongoDB and Chroma count checks returned zero remaining source records and zero vectors. Removed exactly one disposable test account afterwards.

The empty owner-specific vector collection remains; it contains no test vectors.
Console inspection showed service-worker/WebSocket logs and an autocomplete hint,
not application errors. No broad network/performance or accessibility verdict is inferred.

## Limits

- Actual browser → Nginx → backend → Unix bridge → host Ollama and Chroma/Mongo path; no mock inference.
- Reload persistence only in this run; not full process-crash or service-restart persistence.
- Known fact and absent fact are two probes, not a general hallucination-quality guarantee.
- No GPU verification, remote deployment proof, PDF/OCR ingestion, or complete platform claim.
- Visual regression INCONCLUSIVE: no baseline comparison. Accessibility and Core Web Vitals not measured.
