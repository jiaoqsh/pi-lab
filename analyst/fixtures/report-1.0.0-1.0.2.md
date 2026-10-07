# pi-lab run

Versions: pi-ai@1.0.2, pi-durable@1.0.2, pi-codemode@1.0.2, pi-coding-agent@1.0.2

| Experiment | Status | Seconds |
|---|---|---|
| codemode-sandbox | unchanged | 4.3 |
| durable-crash | unchanged | 2.8 |
| durable-examples | updated | 3.5 |
| midconvo-requests | updated | 0.4 |

## durable-examples: updated

```diff
   "20-inbox": [
     "rejected: Conversation 1 is busy",
     "withdraw: aborted",
-    "inbox: [ '9 followUp', '10 steer', '11 write' ]",
+    "inbox: [ '10 followUp', '11 steer', '12 write' ]",
     "first: done ",
     "follow-up: done ",
     "steer: done ",
…
     "  user      What should we eat?",
     "  assistant A detailed answer to \"What should we eat?\": details details details de",
     "",
-    "after \"Which day trips?\" (answered): 6 messages in context, 6 entries stored",
-    "  user      Where should we stay?",
-    "  assistant A detailed answer to \"Where should we stay?\": details details details ",
-    "  user      What should we eat?",
+    "after \"Which day trips?\" (answered): 4 messages in context, 7 entries stored",
+    "  (threshold compaction summary first)",
+    "  user      The conversation history before this point was compacted into the foll",
     "  assistant A detailed answer to \"What should we eat?\": details details details de",
     "  user      Which day trips?",
     "  assistant A detailed answer to \"Which day trips?\": details details details detai",
     "",
-    "after \"Any museums?\" (answered): 4 messages in context, 9 entries stored",
+    "after \"Any museums?\" (answered): 7 messages in context, 10 entries stored",
     "  (threshold compaction summary first)",
     "  user      The conversation history before this point was compacted into the foll",
+    "  assistant A detailed answer to \"What should we eat?\": details details details de",
+    "  user      Which day trips?",
     "  assistant A detailed answer to \"Which day trips?\": details details details detai",
     "  user      Any museums?",
+    "  system    (system prompt)",
     "  assistant A detailed answer to \"Any museums?\": details details details details d",
     "",
-    "after \"Nightlife?\" (answered): 7 messages in context, 12 entries stored",
+    "after \"Nightlife?\" (answered): 5 messages in context, 14 entries stored",
     "  (threshold compaction summary first)",
     "  user      The conversation history before this point was compacted into the foll",
-    "  assistant A detailed answer to \"Which day trips?\": details details details detai",
-    "  user      Any museums?",
     "  assistant A detailed answer to \"Any museums?\": details details details details d",
     "  user      Nightlife?",
     "  system    (system prompt)",
…
     "manual compaction finished; its summary is queued",
     "after the answer, the summary is done",
     "",
-    "after compact(): 4 messages in context, 15 entries stored",
+    "after compact(): 4 messages in context, 17 entries stored",
     "  (manual compaction summary first)",
     "  user      The conversation history before this point was compacted into the foll",
     "  assistant A detailed answer to \"Nightlife?\": details details details details det",
     "  user      How do we get around?",
     "  assistant A detailed answer to \"How do we get around?\": details details details ",
     "",
-    "after \"What should we pack?\" (answered): 7 messages in context, 18 entries stored",
+    "after \"What should we pack?\" (answered): 7 messages in context, 20 entries stored",
     "  (manual compaction summary first)",
     "  user      The conversation history before this point was compacted into the foll",
     "  assistant A detailed answer to \"Nightlife?\": details details details details det",
…
     "  system    (system prompt)",
     "  assistant A detailed answer to \"What should we pack?\": details details details d",
     "",
-    "after \"Summarize the plan for my partner\" (answered): 5 messages in context, 23 entries stored",
-    "  (overflow compaction summary first)",
+    "after \"Summarize the plan for my partner\" (model_error): 4 messages in context, 24 entries stored",
+    "  (threshold compaction summary first)",
     "  user      The conversation history before this point was compacted into the foll",
     "  assistant A detailed answer to \"What should we pack?\": details details details d",
     "  user      Summarize the plan for my partner",
-    "  system    (system prompt)",
-    "  assistant A detailed answer to \"Summarize the plan for my partner\": details deta"
+    "  system    (system prompt)"
   ]
 }
```

## midconvo-requests: updated

```diff
       "topLevelSystem": "[{\"type\":\"text\",\"text\":\"You are a coding assistant.\\n\\n<mode>read-only</mode>\",\"cache_control\":{\"type\":\"ephemeral\"}}]",
       "tools": [
         "read [cache]",
-        "__pi_deferred_placeholder__ (defer_loading)",
-        "deploy (defer_loading)"
+        "__pi_deferred_placeholder__ (defer_loading)"
       ],
       "items": [
         "user: What is in README.md?",
         "assistant: [{\"type\":\"text\",\"text\":\"It describes the project.\"}]",
         "user: Deploy the api.",
-        "system: [{\"type\":\"text\",\"text\":\"Deployments are now allowed.\\n\\nUpdated system prompt section \\\"mode\\\":\\n\\n<mode>deploy</mode>\"},{\"type\":\"tool_addition\",\"tool\":{\"type\":\"tool_reference\",\"name\":\"deploy\"},\"cache…",
+        "system: [{\"type\":\"text\",\"text\":\"Deployments are now allowed.\\n\\nUpdated system prompt section \\\"mode\\\":\\n\\n<mode>deploy</mode>\"},{\"type\":\"tool_addition\",\"tool\":{\"type\":\"tool_definition\",\"definition\":{\"name\":\"…",
         "system: [] output_config={\"effort\":\"high\"}"
       ]
     },
…
```

