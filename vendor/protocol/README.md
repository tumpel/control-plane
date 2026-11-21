These generated packages come from [protocol #87](https://github.com/tumpel/protocol/pull/87), source commit `8a30bb86ef963ff6bbe608fe310ae704ab2204cd` on `feat/53-turn-budget`, merged onto the `v0.21.0-rc.30` tag (`dde9a372b65178f99227f501dccaf17a6c14667d`) so the welcome `ack` field that main uses is present.

Build them in a protocol checkout of `v0.21.0-rc.30` with that commit merged, by `make pack`. The package lock records their integrity hashes.

Replace the local tarballs with the protocol release URLs after that PR merges and publishes its release. Supervisor enforcement ships separately against the same protocol branch.
