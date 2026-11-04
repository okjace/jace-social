"use client";
// Voice room UI: the connected bar in the sidebar, the room view with everyone's tiles and
// screen shares, and the list of who's in a voice channel.
import { StreamVideo } from "./StreamVideo";
import { useEffect, useRef, useState } from "react";
import type { Person } from "@/lib/client";
import { canUseCamera } from "@/lib/media";
import type { RoomState, Voice } from "@/lib/voice";
import { Avatar } from "./ui";

export function useVoice(voice: Voice): RoomState {
  const [s, setS] = useState(voice.state);
  useEffect(() => voice.subscribe(setS), [voice]);
  return s;
}

function Video({ stream, mirror }: { stream: MediaStream; muted?: boolean; mirror?: boolean }) {
  return <StreamVideo stream={stream} mirror={mirror} />;
}

/** "Voice connected" bar above your name, with mute / deafen / screen / leave. */
export function VoiceBar({ voice, state, onOpen }: { voice: Voice; state: RoomState; onOpen: () => void }) {
  if (!state.channelId) return null;
  return (
    <div className="voice-bar">
      <div className="voice-bar-top">
        <div className="grow" onClick={onOpen} style={{ cursor: "pointer", minWidth: 0 }}>
          <b className="voice-ok">{state.connecting ? "Connecting…" : "Voice connected"}</b>
          <span className="muted small">🔊 {state.channelName}</span>
        </div>
        <button className="icon-btn" title="Leave" onClick={() => void voice.leave()}>📞✕</button>
      </div>
      <div className="voice-bar-buttons">
        <button className={`btn small${state.muted || state.noMic ? " danger" : ""}`} onClick={() => void voice.toggleMute()}
          title={state.noMic ? "No microphone - click to try again" : state.muted ? "Unmute" : "Mute"}>{state.muted || state.noMic ? "🎙️✕" : "🎙️"}</button>
        <button className={`btn small${state.deafened ? " danger" : ""}`} onClick={() => void voice.toggleDeafen()} title={state.deafened ? "Undeafen" : "Deafen"}>
          {state.deafened ? "🎧✕" : "🎧"}</button>
        {canUseCamera() && state.canVideo && (
          <button className={`btn small${state.camera ? " primary" : ""}`} onClick={() => void voice.toggleCamera()} title={state.camera ? "Turn off camera" : "Turn on camera"}>📷</button>
        )}
        {"getDisplayMedia" in (navigator.mediaDevices ?? {}) && state.canVideo && (
          <button className={`btn small${state.sharing ? " primary" : ""}`} onClick={() => void voice.toggleScreen()} title={state.sharing ? "Stop sharing" : "Share your screen"}>
            🖥️</button>
        )}
      </div>
    </div>
  );
}

/** Who's in a voice channel (in the channel list). */
export function VoiceUsers({ users, people, speaking }: {
  users: { uuid: string; muted: boolean; deafened: boolean; streaming: boolean }[]; people: Record<string, Person>; speaking: Record<string, boolean>;
}) {
  if (!users.length) return null;
  return (
    <div className="voice-users">
      {users.map((u) => {
        const p = people[u.uuid];
        return (
          <div key={u.uuid} className="voice-user">
            <span className={`ring${speaking[u.uuid] ? " on" : ""}`}><Avatar p={p ?? { name: "?" }} size={22} /></span>
            <span className="name">{p?.nickname || p?.name || "Someone"}</span>
            {u.streaming && <span className="live">LIVE</span>}
            {u.muted && <span title="Muted">🎙️✕</span>}
            {u.deafened && <span title="Deafened">🎧✕</span>}
          </div>
        );
      })}
    </div>
  );
}

/** The room: tiles for everyone, screen shares big. */
export function VoiceRoom({ voice, state, channelId, channelName, people, me, canJoin, onJoin, stage, topic }: {
  voice: Voice; state: RoomState; channelId: string; channelName: string; people: Record<string, Person>; me: Person;
  canJoin: boolean; onJoin: () => void; stage?: boolean; topic?: string | null;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const here = state.channelId === channelId;
  const screens = Object.entries(state.screens);
  const focused = focus && state.screens[focus] ? focus : screens[0]?.[0] ?? null;
  if (!here) {
    return (
      <div className="empty"><div>
        <div style={{ fontSize: 48 }}>{stage ? "🎙️" : "🔊"}</div>
        <h2 style={{ margin: "8px 0" }}>{channelName}</h2>
        {stage && topic && <p>{topic}</p>}
        <p className="muted">{stage ? "A stage: speakers talk, and you listen until a moderator invites you up." : "No one can hear you until you join."}</p>
        <button className="btn primary" disabled={!canJoin} onClick={onJoin}>{!canJoin ? "You can't join this channel" : stage ? "Join the stage" : "Join voice"}</button>
      </div></div>
    );
  }
  if (state.stage) return <StageRoom voice={voice} state={state} people={people} me={me} topic={topic} />;
  return (
    <div className="voice-room">
      {focused && (
        <div className="voice-stage" onDoubleClick={(e) => void (e.currentTarget as HTMLElement).requestFullscreen?.().catch(() => {})}>
          <Video stream={state.screens[focused]} muted={focused === me.uuid} />
          <span className="stage-label">🖥️ {focused === me.uuid ? "You are sharing your screen" : `${people[focused]?.name ?? "Someone"}'s screen`} · double-click for full screen</span>
        </div>
      )}
      <div className={`voice-tiles${focused ? " small" : ""}`}>
        {state.participants.map((pt) => {
          const p = pt.uuid === me.uuid ? me : people[pt.uuid];
          return (
            <div key={pt.uuid} className={`voice-tile${state.speaking[pt.uuid] ? " speaking" : ""}${state.screens[pt.uuid] ? " has-screen" : ""}${state.cameras[pt.uuid] ? " has-camera" : ""}`}
              onClick={() => state.screens[pt.uuid] && setFocus(pt.uuid)}>
              {state.cameras[pt.uuid]
                ? <div className="tile-video"><Video stream={state.cameras[pt.uuid]} muted={pt.uuid === me.uuid} mirror={pt.uuid === me.uuid} /></div>
                : <Avatar p={p ?? { name: "?" }} size={72} />}
              <b>{p?.nickname || p?.name || "Someone"}</b>
              <span className="tile-icons">{pt.muted && "🎙️✕"} {pt.deafened && "🎧✕"} {state.screens[pt.uuid] && <span className="live">LIVE</span>}</span>
            </div>
          );
        })}
      </div>
      <div className="voice-controls">
        <button className={`btn${state.muted ? " danger" : ""}`} onClick={() => void voice.toggleMute()} title={state.noMic ? "No microphone - click to try again" : undefined}>
          {state.noMic ? "🎙️ Try my mic again" : state.muted ? "Unmute" : "Mute"}</button>
        <button className={`btn${state.deafened ? " danger" : ""}`} onClick={() => void voice.toggleDeafen()}>{state.deafened ? "Undeafen" : "Deafen"}</button>
        {canUseCamera() && state.canVideo && <button className={`btn${state.camera ? " primary" : ""}`} onClick={() => void voice.toggleCamera()}>
          {state.camera ? "Turn off camera" : "Turn on camera"}</button>}
        {"getDisplayMedia" in (navigator.mediaDevices ?? {}) && state.canVideo && <button className={`btn${state.sharing ? " primary" : ""}`} onClick={() => void voice.toggleScreen()}>
          {state.sharing ? "Stop sharing" : "Share screen"}</button>}
        <button className="btn danger" onClick={() => void voice.leave()}>Leave</button>
      </div>
    </div>
  );
}

/** A stage: speakers up top, the audience below (raised hands first); moderators pick who speaks. */
function StageRoom({ voice, state, people, me, topic }: { voice: Voice; state: RoomState; people: Record<string, Person>; me: Person; topic?: string | null }) {
  const nameOf = (uuid: string) => { const p = uuid === me.uuid ? me : people[uuid]; return p?.nickname || p?.name || "Someone"; };
  const speakers = state.participants.filter((p) => p.speaker);
  const audience = state.participants.filter((p) => !p.speaker)
    .sort((a, b) => (a.hand_at ? 0 : 1) - (b.hand_at ? 0 : 1) || String(a.hand_at).localeCompare(String(b.hand_at)));
  const mine = state.participants.find((p) => p.uuid === me.uuid);
  const speaking = !!mine?.speaker;
  return (
    <div className="voice-room stage-room">
      {topic && <div className="stage-topic">🎙️ {topic}</div>}
      <div className="side-label">Speakers — {speakers.length}</div>
      <div className="voice-tiles">
        {speakers.length === 0 && <p className="muted">No one is speaking yet{state.moderator ? " - invite someone up from the audience" : ""}.</p>}
        {speakers.map((pt) => (
          <div key={pt.uuid} className={`voice-tile${state.speaking[pt.uuid] ? " speaking" : ""}${state.cameras[pt.uuid] ? " has-camera" : ""}`}>
            {state.cameras[pt.uuid]
              ? <div className="tile-video"><Video stream={state.cameras[pt.uuid]} muted={pt.uuid === me.uuid} mirror={pt.uuid === me.uuid} /></div>
              : <Avatar p={(pt.uuid === me.uuid ? me : people[pt.uuid]) ?? { name: "?" }} size={72} />}
            <b>{nameOf(pt.uuid)}</b>
            <span className="tile-icons">{pt.muted && "🎙️✕"}</span>
            {state.moderator && pt.uuid !== me.uuid && <button className="btn small" onClick={() => void voice.setSpeaker(pt.uuid, false)}>Move to audience</button>}
          </div>
        ))}
      </div>
      <div className="side-label">Audience — {audience.length}</div>
      <div className="stage-audience">
        {audience.map((pt) => (
          <div key={pt.uuid} className={`stage-listener${pt.hand_at ? " hand" : ""}`}>
            <Avatar p={(pt.uuid === me.uuid ? me : people[pt.uuid]) ?? { name: "?" }} size={36} />
            <span>{pt.hand_at && "✋ "}{nameOf(pt.uuid)}</span>
            {state.moderator && <button className="btn small primary" onClick={() => void voice.setSpeaker(pt.uuid, true)}>{pt.hand_at ? "Let them speak" : "Invite to speak"}</button>}
          </div>
        ))}
      </div>
      <div className="voice-controls">
        {speaking ? <>
          <button className={`btn${state.muted ? " danger" : ""}`} onClick={() => void voice.toggleMute()}>{state.noMic ? "🎙️ Try my mic again" : state.muted ? "Unmute" : "Mute"}</button>
          {canUseCamera() && state.canVideo && <button className={`btn${state.camera ? " primary" : ""}`} onClick={() => void voice.toggleCamera()}>
            {state.camera ? "Turn off camera" : "Turn on camera"}</button>}
          <button className="btn" onClick={() => void voice.setSpeaker(me.uuid, false)}>Step down</button>
        </> : state.moderator
          ? <button className="btn primary" onClick={() => void voice.setSpeaker(me.uuid, true)}>Speak</button>
          : <button className={`btn${mine?.hand_at ? " primary" : ""}`} onClick={() => void voice.raiseHand(!mine?.hand_at)}>{mine?.hand_at ? "✋ Lower hand" : "✋ Raise hand"}</button>}
        <button className={`btn${state.deafened ? " danger" : ""}`} onClick={() => void voice.toggleDeafen()}>{state.deafened ? "Undeafen" : "Deafen"}</button>
        <button className="btn danger" onClick={() => void voice.leave()}>Leave</button>
      </div>
    </div>
  );
}
