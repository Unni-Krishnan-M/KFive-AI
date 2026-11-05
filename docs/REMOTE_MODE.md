# Remote Mode

Remote mode now has an **Experimental production-Compose foundation**, not a completed remote deployment. Bounded local acceptance passed the private topology, authenticated OpenAI-compatible provider protocol, browser chat, Mongo restart/recreation persistence, and strict private-CA TLS/proxy routing. It used local images, one Docker host, and a private provider fixture.

For a real deployment, set `KFIVE_MODE=remote`, use [the production procedure](REMOTE_DEPLOYMENT.md) and [TLS edge](TLS.md), configure digest-pinned images, strong distinct secrets, an exact HTTPS public origin, and an authenticated HTTPS provider reachable from the server. Only same-host/same-datastore-image application recovery and private-CA TLS have passed; real remote-host persistence/DR, public DNS/trust and renewal, external-provider smoke, migration/cutover, and proof with the development laptop offline have not been executed.
