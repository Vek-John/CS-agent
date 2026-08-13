# Project operating rules

- Read `PRD.md`, `ARCHITECTURE.md`, and `MVP_SCOPE.md` before changing product behavior. `ARCHITECTURE.md` is the only long-lived architecture source of truth.
- The primary product is a guided, full-match coaching session, not a report or issue dashboard.
- Preserve full timeline coverage, explicit skips, decision-before-outcome teaching, and the observable-state future-information boundary.
- Never label synthetic fixture time or video media time as an exact Demo tick. Only a parsed Demo supplies canonical ticks.
- Keep facts, inferences, advice, and evidence separate. Parser code emits facts, not coaching conclusions.
- Keep the MVP a modular monolith plus worker. Do not add microservices or unrelated infrastructure.
- Frontend work must use the installed `emil-design-eng` and `apple-design` skills, remain usable on localhost, and support reduced motion/transparency.
- Run relevant tests, TypeScript checks, and production build before handing work back. Report exact remaining limitations.
- Avoid editing `PRD.md` or `MVP_SCOPE.md` unless product scope truly changes. Update `ARCHITECTURE.md` for architectural contracts or boundaries.
