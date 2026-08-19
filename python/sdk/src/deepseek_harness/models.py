from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal, TypeAlias

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

JsonScalar: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonScalar | dict[str, "JsonValue"] | list["JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]
ImageMediaType: TypeAlias = Literal["image/png", "image/jpeg", "image/webp", "image/gif"]


@dataclass(slots=True)
class Notification:
    method: str
    payload: JsonObject


@dataclass(slots=True)
class IncomingRequest:
    id: str | int
    method: str
    payload: JsonObject


class ServerInfo(BaseModel):
    name: str | None = None
    version: str | None = None


class InitializeResponse(BaseModel):
    serverInfo: ServerInfo | None = None


class ModelCatalogReasoningEffort(BaseModel):
    id: StrictStr = Field(min_length=1)
    name: StrictStr = Field(min_length=1)
    description: StrictStr | None = None


class ModelCatalogReasoning(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    efforts: list[ModelCatalogReasoningEffort] = Field(min_length=1)
    default_effort: StrictStr | None = Field(default=None, alias="defaultEffort")

    @model_validator(mode="after")
    def validate_efforts(self) -> ModelCatalogReasoning:
        ids = [effort.id for effort in self.efforts]
        if len(set(ids)) != len(ids):
            raise ValueError("catalog reasoning effort ids must be unique")
        if self.default_effort is not None and self.default_effort not in ids:
            raise ValueError("catalog reasoning defaultEffort must name a supported effort")
        return self


class ModelCatalogEntry(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    name: str
    description: str | None = None
    input_modalities: list[str] | None = Field(default=None, alias="inputModalities")
    reasoning: ModelCatalogReasoning | None = None


class ModelProviderCatalog(BaseModel):
    id: str
    name: str
    models: list[ModelCatalogEntry]


class ModelCatalogFailure(BaseModel):
    id: str
    name: str
    message: str


class ModelCatalogResponse(BaseModel):
    providers: list[ModelProviderCatalog]
    failures: list[ModelCatalogFailure]


class ProviderAuthMethod(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["api_key", "oauth"]
    label: StrictStr = Field(min_length=1)


class ProviderAuthInfoResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    provider: StrictStr = Field(min_length=1)
    methods: list[ProviderAuthMethod]
    configured: StrictBool
    credential_type: Literal["api_key", "oauth"] | None = Field(
        default=None, alias="credentialType"
    )
    source: StrictStr | None = Field(default=None, min_length=1)

    @model_validator(mode="after")
    def validate_unique_methods(self) -> ProviderAuthInfoResponse:
        if len({method.type for method in self.methods}) != len(self.methods):
            raise ValueError("provider auth method types must be unique")
        return self


class ProviderAuthStartResponse(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    flow_id: StrictStr = Field(alias="flowId", min_length=1)


class ProviderAuthResponseReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    accepted: StrictBool
    reason: Literal["not-pending", "bad-flow"] | None = None


class ProviderAuthCancelResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requested: StrictBool


class ProviderAuthLogoutResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    disconnected: Literal[True]


class ProviderAuthPromptOption(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: StrictStr = Field(min_length=1)
    label: StrictStr = Field(min_length=1)
    description: StrictStr | None = None

    @model_validator(mode="before")
    @classmethod
    def reject_null_description(cls, value: object) -> object:
        if isinstance(value, dict) and "description" in value and value["description"] is None:
            raise ValueError("auth prompt option description must be a string when present")
        return value


class ProviderAuthPrompt(BaseModel):
    model_config = ConfigDict(extra="forbid")
    type: Literal["text", "secret", "manual_code", "select"]
    message: StrictStr
    placeholder: StrictStr | None = None
    options: list[ProviderAuthPromptOption] | None = None

    @model_validator(mode="before")
    @classmethod
    def validate_wire_shape(cls, value: object) -> object:
        if isinstance(value, dict):
            prompt_type = value.get("type")
            if prompt_type == "select" and "placeholder" in value:
                raise ValueError("select auth prompt does not accept placeholder")
            if prompt_type != "select" and "options" in value:
                raise ValueError("only select auth prompt accepts options")
            if "placeholder" in value and value["placeholder"] is None:
                raise ValueError("auth prompt placeholder must be a string when present")
        return value

    @model_validator(mode="after")
    def validate_prompt_shape(self) -> ProviderAuthPrompt:
        if self.type == "select" and not self.options:
            raise ValueError("select auth prompt requires options")
        return self


class ProviderAuthEventNotification(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    flow_id: StrictStr = Field(alias="flowId", min_length=1)
    provider: StrictStr = Field(min_length=1)
    event: dict[str, object]

    @field_validator("event")
    @classmethod
    def validate_event(cls, event: dict[str, object]) -> dict[str, object]:
        kind = event.get("type")
        keys = set(event)
        if (
            kind == "progress"
            and keys == {"type", "message"}
            and isinstance(event.get("message"), str)
        ):
            return event
        if (
            kind == "info"
            and keys <= {"type", "message", "links"}
            and {"type", "message"} <= keys
            and isinstance(event.get("message"), str)
        ):
            links = event.get("links")
            if "links" not in event or (
                isinstance(links, list)
                and all(
                    isinstance(link, dict)
                    and set(link) <= {"url", "label"}
                    and isinstance(url := link.get("url"), str)
                    and len(url) > 0
                    and ("label" not in link or isinstance(link.get("label"), str))
                    for link in links
                )
            ):
                return event
        if (
            kind == "auth_url"
            and keys <= {"type", "url", "instructions"}
            and {"type", "url"} <= keys
            and isinstance(event.get("url"), str)
            and len(event["url"]) > 0
            and (
                "instructions" not in event
                or isinstance(event.get("instructions"), str)
            )
        ):
            return event
        if (
            kind == "device_code"
            and keys
            <= {
                "type",
                "userCode",
                "verificationUri",
                "intervalSeconds",
                "expiresInSeconds",
            }
            and {"type", "userCode", "verificationUri"} <= keys
            and isinstance(event.get("userCode"), str)
            and len(event["userCode"]) > 0
            and isinstance(event.get("verificationUri"), str)
            and len(event["verificationUri"]) > 0
            and all(
                key not in event
                or (
                    type(event[key]) is int
                    and 0 < event[key] <= 9_007_199_254_740_991
                )
                for key in ("intervalSeconds", "expiresInSeconds")
            )
        ):
            return event
        raise ValueError("invalid provider auth event")


class ProviderAuthPromptNotification(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    flow_id: StrictStr = Field(alias="flowId", min_length=1)
    provider: StrictStr = Field(min_length=1)
    prompt_id: StrictStr = Field(alias="promptId", min_length=1)
    prompt: ProviderAuthPrompt


class ProviderAuthPromptResolvedNotification(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    flow_id: StrictStr = Field(alias="flowId", min_length=1)
    prompt_id: StrictStr = Field(alias="promptId", min_length=1)


class ProviderAuthFinishedNotification(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)
    flow_id: StrictStr = Field(alias="flowId", min_length=1)
    provider: StrictStr = Field(min_length=1)
    outcome: Literal["success", "cancelled", "error"]
    message: StrictStr | None = None


PROVIDER_AUTH_NOTIFICATION_MODELS: dict[str, type[BaseModel]] = {
    "provider.auth.event": ProviderAuthEventNotification,
    "provider.auth.prompt": ProviderAuthPromptNotification,
    "provider.auth.promptResolved": ProviderAuthPromptResolvedNotification,
    "provider.auth.finished": ProviderAuthFinishedNotification,
}


class ImageAttachmentLimits(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    max_image_bytes: StrictInt = Field(alias="maxImageBytes", gt=0, le=9_007_199_254_740_991)
    max_images_per_message: StrictInt = Field(
        alias="maxImagesPerMessage", gt=0, le=9_007_199_254_740_991
    )
    max_message_image_bytes: StrictInt = Field(
        alias="maxMessageImageBytes", gt=0, le=9_007_199_254_740_991
    )
    max_image_pixels: StrictInt = Field(alias="maxImagePixels", gt=0, le=9_007_199_254_740_991)
    media_types: list[ImageMediaType] = Field(alias="mediaTypes", min_length=1)

    @model_validator(mode="after")
    def validate_unique_media_types(self) -> ImageAttachmentLimits:
        if len(set(self.media_types)) != len(self.media_types):
            raise ValueError("attachment mediaTypes must be unique")
        return self


class ImageAttachmentRef(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    attachment_id: StrictStr = Field(alias="attachmentId", min_length=1)
    media_type: ImageMediaType = Field(alias="mediaType")
    bytes: StrictInt = Field(gt=0, le=9_007_199_254_740_991)
    width: StrictInt = Field(gt=0, le=9_007_199_254_740_991)
    height: StrictInt = Field(gt=0, le=9_007_199_254_740_991)
    name: StrictStr | None = Field(default=None, min_length=1)


class ModelSelectionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    provider: str
    model: str
    reasoning_effort: str | None = Field(default=None, alias="reasoningEffort")


class SessionHeader(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    version: Literal[0]
    id: str
    created_at: StrictInt = Field(alias="createdAt", ge=0, le=9_007_199_254_740_991)
    cwd: str | None = None
    parent_session: str | None = Field(default=None, alias="parentSession")
    seed_length: StrictInt | None = Field(default=None, alias="seedLength", ge=0)
    origin: Literal["subagent"] | None = None
    delegation_depth: StrictInt | None = Field(default=None, alias="delegationDepth", ge=0)
    agent_preset: str | None = Field(default=None, alias="agentPreset")


class SessionListEntry(BaseModel):
    header: SessionHeader
    live: StrictBool
    persisted: StrictBool


class SessionListResponse(BaseModel):
    sessions: list[SessionListEntry]


def _is_json_value(value: object) -> bool:
    if value is None or isinstance(value, (str, bool)):
        return True
    if isinstance(value, (int, float)):
        return not isinstance(value, float) or math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(isinstance(key, str) and _is_json_value(item) for key, item in value.items())
    return False


class SurfaceReplaceOp(BaseModel):
    model_config = ConfigDict(extra="forbid")

    op: Literal["replace"]
    start: StrictInt = Field(ge=0, le=9_007_199_254_740_991)
    end: StrictInt = Field(ge=0, le=9_007_199_254_740_991)


SurfaceOp: TypeAlias = Literal["append"] | SurfaceReplaceOp


class SessionHistoryEvent(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    type: StrictStr
    seq: StrictInt = Field(ge=0, le=9_007_199_254_740_991)
    time: StrictInt = Field(ge=-9_007_199_254_740_991, le=9_007_199_254_740_991)
    data: dict[str, object]
    surface_op: SurfaceOp | None = Field(default=None, alias="surfaceOp")
    source_event_seqs: list[StrictInt] | None = Field(default=None, alias="sourceEventSeqs")
    ignorable: Literal[True] | None = None

    @field_validator("surface_op", mode="before")
    @classmethod
    def reject_null_surface_op(cls, value: object) -> object:
        if value is None:
            raise ValueError("surfaceOp must be append or an exact replace operation")
        return value

    @model_validator(mode="after")
    def validate_envelope(self) -> SessionHistoryEvent:
        if not self.type:
            raise ValueError("session event type must be non-empty")
        if not _is_json_value(self.data):
            raise ValueError("session event payload must be a JSON value")
        if self.source_event_seqs is not None and any(
            seq < 0 or seq > 9_007_199_254_740_991 for seq in self.source_event_seqs
        ):
            raise ValueError("sourceEventSeqs must contain non-negative safe integers")
        return self


class SessionHistoryResponse(BaseModel):
    session: SessionHeader
    events: list[SessionHistoryEvent]

    @model_validator(mode="after")
    def validate_event_sequence(self) -> SessionHistoryResponse:
        if any(event.seq != index for index, event in enumerate(self.events)):
            raise ValueError("session event sequence must be contiguous from zero")
        return self


class SessionResumeResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    session_id: str = Field(alias="sessionId")


class InteractionResponseReceipt(BaseModel):
    accepted: StrictBool
    reason: Literal["not-pending", "bad-response"] | None = None


class CommandInputDescriptor(BaseModel):
    hint: str


class CommandDescriptor(BaseModel):
    name: str
    description: str
    input: CommandInputDescriptor | None = None


class CommandListResponse(BaseModel):
    available: StrictBool
    commands: list[CommandDescriptor]


class CommandExecutionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    outcome: Literal["unavailable", "unknown-command", "success", "error"]
    command_id: str | None = Field(default=None, alias="commandId")
    text: str | None = None
    message: str | None = None
    source_event_seq: StrictInt | None = Field(
        default=None,
        alias="sourceEventSeq",
        ge=0,
        le=9_007_199_254_740_991,
    )

    @model_validator(mode="after")
    def validate_outcome_fields(self) -> CommandExecutionResponse:
        if self.outcome == "success" and self.command_id is None:
            raise ValueError("successful command response requires commandId")
        if self.outcome in {"unavailable", "unknown-command", "error"} and self.message is None:
            raise ValueError(f"{self.outcome} command response requires message")
        return self
