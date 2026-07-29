---
'@ianlancaster/agent-conductor': patch
---

Distinguish a schedule that fired from one that arrived. A cron send into a session that cannot
receive — one holding an unanswered prompt or a draft — was reported as `fired`, so a fleet's
scheduled sweep can stop reaching its owner while the event stream says it ran. Observed live: ten
consecutive 30-minute sentinel sweeps fired on time, were held in the delivery queue behind an
unanswered prompt, and reported `fired` every time; nobody learned the fleet had gone unswept for
five hours. The `schedule` event now reports `queued` when delivery held the prompt, and the log
line says it was held.
