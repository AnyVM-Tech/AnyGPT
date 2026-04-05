# Product Scope

## Positioning

SurfaceScope is a safer alternative to public exposure-indexing workflows:

- authorized assets only
- evidence-first triage
- disclosure-safe workflow
- compliance-aware reporting

## Core jobs to be done

1. Maintain an approved asset inventory with ownership, business criticality, and authorization state.
2. Ingest machine-readable findings from scanners, sensors, or internal feeds.
3. Show which findings need:
   - owner confirmation
   - remediation
   - coordinated disclosure
   - audit follow-up
4. Preserve a durable evidence log for each exposure and remediation decision.

## Product guardrails

- No anonymous third-party target enumeration features.
- No raw exploit guidance.
- No “better search engine for strangers’ infrastructure” positioning.
- New features should strengthen authorization proof, evidence quality, or disclosure workflow quality.

## Competitive legal controls to encode

- Require an explicit authorization basis and an internal reference for every monitored asset.
- Classify finding visibility so newly reported issues can stay in an internal or trusted-researcher window before any wider publication.
- Track report status, intended recipients, and escalation targets for each finding.
- Preserve opt-out, takedown, and abuse-handling workflow as first-class product work, not an afterthought.
- Keep privacy controls visible: data minimization, KYC/reviewer controls, and lawful-contact handling should be represented in the workflow rather than buried in policy text alone.

## Evidence packet workflow to encode

Every finding should be able to move through a consistent evidence-first workflow before remediation or disclosure decisions:

1. **Authorization check**
   - Link the finding to the approved asset record and exact approved resource.
   - Preserve the authorization basis and internal approval reference used for collection.
2. **Collection metadata**
   - Record the collection method, capture timestamp, reviewer, and whether the artifact came from a scanner, manual verification step, or owner-provided proof.
   - Track redaction status so screenshots, headers, and response samples can be shared safely.
3. **Evidence readiness**
   - Mark whether the evidence is sufficient for owner notification, remediation planning, coordinated disclosure, or audit follow-up.
   - Distinguish missing-proof cases from verified exposure cases so the queue does not treat them the same way.
4. **Retention and handoff**
   - Keep a durable storage reference for each evidence packet and record who is allowed to view it.
   - Preserve the recipient list, escalation path, and disclosure window that applies once the packet is ready.

This workflow keeps SurfaceScope focused on authorized assets, machine-readable findings, and evidence-backed remediation instead of unbounded public indexing.

## Suggested next bounded improvements

- importer for scanner exports
- asset-ownership attestation workflow
- disclosure packet export
- security.txt remediation and disclosure workflow improvements
- authenticated asset-group views
