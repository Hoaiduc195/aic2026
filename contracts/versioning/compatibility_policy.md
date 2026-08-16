# Contract v1 compatibility policy

## Authority

JSON Schemas under `contracts/schemas/` are the canonical source of truth.
Examples under `contracts/examples/` and generated provider/consumer types are
derived artifacts. Prose documentation may explain a contract but may not
define a different payload shape.

## Version tuple

Every published artifact or online response must identify:

```text
dataset_version + pipeline_version + schema_version + index_version
```

Mixing records from incompatible tuples is invalid even when each individual
JSON document passes its local schema.

## Allowed v1 changes

- Add an optional property with a documented default/absence meaning.
- Add an enum value only after every consumer handles unknown values safely.
- Add a new schema for a new boundary or task output.
- Add a legacy alias while keeping the canonical field and migration note.

## Breaking changes

The following require a new major schema version or an explicit adapter:

- renaming or removing a required property;
- changing an identifier's type or frame numbering convention;
- changing timestamp units or interval semantics;
- changing a required enum meaning;
- making an optional property required;
- changing a task result from one frame to an ordered sequence.

## Migration rules

- `original_frame_id` remains the authoritative internal source-frame key.
  `frame_id` may be retained only as a legacy or organizer mapping field.
- Legacy search payloads must be converted to the versioned `search_response`
  or `qualification_response` before they cross the backend boundary.
- Organizer-specific conversion is disabled by default and must not alter the
  internal retrieval contracts.

## Review checklist

1. Update the schema before changing a provider or consumer.
2. Add valid and invalid fixtures for every new conditional/error path.
3. Run Python/TypeScript contract validation against the same schema.
4. Record the compatibility impact and migration path in the change review.
5. Reject incompatible dataset, pipeline, schema, or index versions before
   partial ingestion or response publication.
