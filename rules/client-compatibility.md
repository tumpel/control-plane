# Client compatibility

1. Releases must activate clients before the API that serves the change. Clients must keep working with the previous API during rollout.
2. Response consumers must model unknown enum values, failure reasons and pause reasons explicitly at the owning boundary. They must tolerate extra response fields and preserve known work.
3. An unknown response value must never throw or crash a consumer. It must show a plain message that the service sent a value this version does not recognise and that the client likely needs an update.
4. Request validation stays strict. Response tolerance must never admit unknown request values.
5. Scenario tests must feed unknown values through the real client and consumer, assert the update message, and continue known work.
6. Readiness acknowledgements cover Tumpel-run clients. Externally installed clients and cached browsers rely on tolerant decoding.
