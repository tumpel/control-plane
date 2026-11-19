# 010. A timed-out turn continues on the harness's own resume

Status: accepted

The host owns the turn time limit. At its limit the supervisor stops the harness, keeps the box and reports `TurnTimedOut`, and a snapshot follows as for every turn. The guest starts each later turn with the harness's own resume, and the harness keeps its conversation on the box disk, so the next turn on the session continues the work. The control plane's whole-turn deadline restarts when the repository is ready and adds the heartbeat deadline, so the host always reports first. That deadline only catches a host that stops answering.

This follows tenets 1 and 2. The supervisor, the guest and the channel protocol stay as they are. A Firecracker memory snapshot at the limit is rejected because it needs a supervisor change. The cost is that the tool call and the model request in flight at the limit are lost, and the harness resumes after its last written message. The gain is that continuation ships with no supervisor release.
