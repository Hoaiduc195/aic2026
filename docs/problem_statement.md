# Problem statement

The system must find exact moments in long videos from Vietnamese, English or
mixed natural-language queries. A result is useful only when the backend can
identify the video, exact source frame, timestamp, playable preview and the
evidence supporting the match.

## Core model

```text
video → decoded frame timeline → sparse keyframes → modality evidence
```

The source-frame key is `(video_id, original_frame_id)`. OCR, caption and object
records attach to a frame. ASR remains a half-open time interval and can be
anchored to the nearest frame for display or manual selection.

## Product tasks

- Textual KIS: return the best exact frames for a text description.
- VQA: retrieve visual/text/audio evidence before answering.
- TRAKE: return an ordered list of frames for ordered events.

## Constraints

- Preserve PTS/timestamp provenance and integer millisecond intervals.
- Keep model/checkpoint/schema/pipeline versions with every artifact.
- Make missing or unavailable modalities explicit.
- Never expose R2 secrets to the browser.
- Keep candidate identity stable across branch fusion and manual revision.

## Success criteria

- Correct frame appears early in ranked results.
- Preview URI resolves to the intended video/keyframe.
- Evidence IDs can be loaded independently and audited.
- Re-running an import is idempotent and does not duplicate evidence.
- Query responses remain useful when one branch or external service is down.
