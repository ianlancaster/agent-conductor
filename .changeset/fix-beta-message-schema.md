---
'agent-conductor': patch
---

Repair pause and protected-message columns when opening databases from the retired beta rooms build, whose migration versions collided with the main schema. Preserve existing messages, delivery policies, and legacy tables; local and federated protected sends can return receipts again after migration.
