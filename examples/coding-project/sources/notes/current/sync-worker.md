# Sync Worker Notes

The worker stages candidate data first, verifies the candidate, then activates the remote
pointer.

If verification fails, leave the previous build serving and keep the receipt. The operator can
resume from the recorded receipt id.

The worker should log the build id, target id and receipt id for every deployment attempt.
