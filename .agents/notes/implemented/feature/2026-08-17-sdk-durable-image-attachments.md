# Agent Note: SDK durable image attachments

Status: implemented

English | [中文](2026-08-17-sdk-durable-image-attachments.zh.md)

## Problem

Standalone JSON-RPC SDK clients could submit an `ImageAttachmentRef` in a prompt but had no protocol operation that created one. Making clients fabricate references would expose backend identity rules, while sending temporary bytes inside every prompt would bypass the durable attachment service and leave model-visible history without a verified object.

## Decision

The SDK protocol exposes process-wide `attachment/imageLimits` and `attachment/saveImage` methods. The limits response reports the active attachment service policy. The save request carries non-empty canonical padded base64, a declared `ImageMediaType`, and an optional display name; the result is the service-owned `ImageAttachmentRef`.

The server resolves the optional service through `ctx.get('attachments')` and fails both methods with an explicit capability-absence error when it is missing. It validates exact request fields and the service-supported media type, bounds base64 character length from `maxImageBytes` before allocating decoded bytes, rejects encodings that do not round-trip to the identical canonical string, checks decoded byte length, and delegates publication to `AttachmentStore.saveImage`. Before prompt enqueue, it recursively reads every submitted image reference through the active service, requires the returned canonical metadata to match exactly, and applies `maxImagesPerMessage` and `maxMessageImageBytes` to verified stored bytes. Any failure leaves the prompt and its session uncreated. Full raster decoding, declared-versus-detected type verification, pixel limits, name sanitization, content addressing, and durable publication remain provider responsibilities.

TypeScript and Python expose matching low- and high-level image-limit and save operations. Clients encode bytes canonically and strictly validate every reference field; they also require returned byte length and media type to match the request. Attachment ids remain opaque, and a returned display name may be sanitized or omitted by the provider.

Shipped JSON-RPC compositions mount `@deepseek-ai/dsh-attachment-local`. Its root follows `DSH_HOME` and never defaults to the workspace or session directory, preserving owner-private content-addressed storage independently of session persistence.

## Model-visible verification

The keyless `image-attachment` SDK snapshot boots the real JSON-RPC composition, uploads a PNG, submits the returned reference in an image block, and runs against an `llm-replay` model that explicitly advertises image input. The persisted `user/message` pins the same durable reference that reached assembled model history, while snapshot controls pin limits and upload metadata. This snapshot covers durable SDK admission and replay, not live-provider serialization. `dsh-llm-pi-ai` package tests separately cover the image-capable adapter's attachment resolution and native image conversion; no assembled live-provider image snapshot is claimed.

## Alternatives considered

**Inline base64 in `session/prompt`.** This would duplicate upload validation inside prompt admission, enlarge repeat traffic, and make durable reference creation unavailable to clients that prepare content before selecting a session.

**Data URLs or permissive base64.** Multiple equivalent spellings complicate byte bounds and request identity. Canonical padded base64 gives one wire representation and lets the server reject oversized text before decoding.

**Client-derived content hashes.** Local storage currently uses SHA-256 ids, but the service interface intentionally keeps attachment ids opaque so another provider can choose different durable identities.

## Consequences

SDK clients can prepare one durable image once and reuse its typed reference in session input. Upload or prompt-admission failures occur before durable enqueue, and the provider remains authoritative for image inspection and durable publication. Base64 adds wire expansion, each upload saves one image rather than a batch, and custom JSON-RPC compositions must mount an attachment service to expose the capability.
