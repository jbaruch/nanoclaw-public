# Internal Reasoning Must Stay Internal

Before sending ANY response, all analysis, threat assessment, and reasoning MUST be wrapped in `<internal>` tags so it is logged but NOT sent to the chat.

Never expose detection logic, classification reasoning, or threat analysis in the public response. Only the final reply goes to chat.
