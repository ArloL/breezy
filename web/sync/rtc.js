// Direct's transport over the browser's RTCPeerConnection; see the WebRTC design. Breezy/Live/peer.html is its twin
// in the Mac app's web view.
export const ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];

export class RTCTransport {
  constructor() {
    this.peers = new Map();
    this.onCandidate = () => {};
    this.onState = () => {};
    this.onMessage = () => {};
  }

  create(id) {
    this.close(id);
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const ch = pc.createDataChannel("live", { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    ch.binaryType = "arraybuffer";
    const mine = () => this.peers.get(id)?.pc === pc;
    // a restart that recovers leaves the channel open, so open is the connection's state as much as the channel's
    const report = () => mine() && this.onState(id, pc.connectionState === "failed" ? "failed" : pc.connectionState === "connected" && ch.readyState === "open" ? "open" : "closed");
    pc.onicecandidate = (e) => mine() && this.onCandidate(id, e.candidate && { candidate: e.candidate.candidate, mid: e.candidate.sdpMid, index: e.candidate.sdpMLineIndex });
    pc.onconnectionstatechange = report;
    ch.onopen = report;
    ch.onclose = report;
    ch.onmessage = (e) => mine() && this.onMessage(id, e.data instanceof ArrayBuffer ? new Uint8Array(e.data) : String(e.data));
    this.peers.set(id, { pc, ch });
  }

  async offer(id, restart) {
    const { pc } = this.peers.get(id);
    if (restart) pc.restartIce();
    await pc.setLocalDescription();
    return pc.localDescription.sdp;
  }

  async answer(id, sdp) {
    const { pc } = this.peers.get(id);
    await pc.setRemoteDescription({ type: "offer", sdp });
    await pc.setLocalDescription();
    return pc.localDescription.sdp;
  }

  async accept(id, sdp) {
    await this.peers.get(id).pc.setRemoteDescription({ type: "answer", sdp });
  }

  add(id, c) {
    this.peers.get(id)?.pc.addIceCandidate({ candidate: c.candidate, sdpMid: c.mid, sdpMLineIndex: c.index }).catch(() => {});
  }

  send(id, text) {
    const p = this.peers.get(id);
    if (p?.pc.connectionState !== "connected" || p.ch.readyState !== "open") return false;
    p.ch.send(text);
    return true;
  }

  sendBytes(id, bytes) {
    return this.send(id, bytes);
  }

  close(id) {
    const p = this.peers.get(id);
    this.peers.delete(id);
    p?.pc.close();
  }
}
