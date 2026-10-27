import Foundation
import Security

/// A small WebSocket client (RFC 6455) for iOS 12, which has no URLSessionWebSocketTask (iOS 13+):
/// a TLS stream (URLSessionStreamTask), the HTTP upgrade, then text frames both ways. Enough for
/// Supabase Realtime (Live.swift): text messages, ping/pong and close.
final class WebSocket: NSObject {
    var onOpen: (() -> Void)?
    var onText: ((String) -> Void)?
    /// the connection ended (an error, the server closed it, or close())
    var onClose: (() -> Void)?

    private let url: URL
    private var task: URLSessionStreamTask?
    private var buffer = Data()
    private var open = false
    private var closed = false
    private var fragments = Data()
    private let queue = DispatchQueue(label: "dev.jacedeb.jacesocial.websocket")

    init(url: URL) { self.url = url }

    func connect() {
        let secure = url.scheme == "wss" || url.scheme == "https"
        let port = url.port ?? (secure ? 443 : 80)
        let t = URLSession.shared.streamTask(withHostName: url.host ?? "", port: port)
        task = t
        t.resume()
        if secure { t.startSecureConnection() }
        var path = url.path.isEmpty ? "/" : url.path
        if let q = url.query { path += "?" + q }
        var key = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, key.count, &key)
        let host = url.port.map { "\(url.host ?? ""):\($0)" } ?? (url.host ?? "")
        let hello = "GET \(path) HTTP/1.1\r\nHost: \(host)\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            + "Sec-WebSocket-Key: \(Data(key).base64EncodedString())\r\nSec-WebSocket-Version: 13\r\n"
            + "User-Agent: JaceSocialiOS12\r\n\r\n"
        t.write(Data(hello.utf8), timeout: 30) { [weak self] error in
            if error != nil { self?.finish() } else { self?.readHandshake() }
        }
    }

    func close() {
        queue.async {
            guard !self.closed else { return }
            self.sendFrame(opcode: 0x8, payload: Data())
            self.finish()
        }
    }

    func send(_ text: String) {
        queue.async { if self.open && !self.closed { self.sendFrame(opcode: 0x1, payload: Data(text.utf8)) } }
    }

    // --- reading

    /// Read more from the stream into the buffer, then go on.
    private func more(_ then: @escaping () -> Void) {
        guard let t = task, !closed else { return }
        t.readData(ofMinLength: 1, maxLength: 65536, timeout: 120) { [weak self] data, eof, error in
            guard let self = self else { return }
            self.queue.async {
                if let d = data, !d.isEmpty { self.buffer.append(d) }
                if error != nil || (eof && (data?.isEmpty ?? true)) { self.finish(); return }
                then()
            }
        }
    }

    private func readHandshake() {
        queue.async {
            guard let end = self.buffer.range(of: Data("\r\n\r\n".utf8)) else { self.more { self.readHandshake() }; return }
            let head = String(data: self.buffer.subdata(in: 0..<end.lowerBound), encoding: .utf8) ?? ""
            self.buffer.removeSubrange(0..<end.upperBound)
            guard head.hasPrefix("HTTP/1.1 101") else { self.finish(); return }
            self.open = true
            DispatchQueue.main.async { self.onOpen?() }
            self.readFrames()
        }
    }

    private func readFrames() {
        // as many whole frames as the buffer holds, then wait for more
        while let frame = takeFrame() {
            handle(opcode: frame.opcode, fin: frame.fin, payload: frame.payload)
            if closed { return }
        }
        more { self.readFrames() }
    }

    private func takeFrame() -> (opcode: UInt8, fin: Bool, payload: Data)? {
        let b = [UInt8](buffer.prefix(14))
        guard b.count >= 2 else { return nil }
        let fin = b[0] & 0x80 != 0, opcode = b[0] & 0x0f, masked = b[1] & 0x80 != 0
        var length = Int(b[1] & 0x7f), offset = 2
        if length == 126 {
            guard b.count >= 4 else { return nil }
            length = Int(b[2]) << 8 | Int(b[3]); offset = 4
        } else if length == 127 {
            guard b.count >= 10 else { return nil }
            length = (2..<10).reduce(0) { $0 << 8 | Int(b[$1]) }; offset = 10
        }
        var mask: [UInt8] = []
        if masked {
            guard b.count >= offset + 4 else { return nil }
            mask = Array(b[offset..<offset + 4]); offset += 4
        }
        guard buffer.count >= offset + length else { return nil }
        var payload = buffer.subdata(in: buffer.startIndex + offset..<buffer.startIndex + offset + length)
        if masked { payload = Data(payload.enumerated().map { $0.element ^ mask[$0.offset % 4] }) }
        buffer = buffer.subdata(in: buffer.startIndex + offset + length..<buffer.endIndex)
        return (opcode, fin, payload)
    }

    private func handle(opcode: UInt8, fin: Bool, payload: Data) {
        switch opcode {
        case 0x0, 0x1:                                   // text (or the rest of one)
            fragments.append(payload)
            if fin {
                let text = String(data: fragments, encoding: .utf8)
                fragments = Data()
                if let t = text { DispatchQueue.main.async { self.onText?(t) } }
            }
        case 0x8: finish()                               // the server closed it
        case 0x9: sendFrame(opcode: 0xA, payload: payload)  // ping -> pong
        default: break
        }
    }

    // --- writing (frames from a client are masked)

    private func sendFrame(opcode: UInt8, payload: Data) {
        guard let t = task else { return }
        var frame = Data([0x80 | opcode])
        let n = payload.count
        if n < 126 {
            frame.append(0x80 | UInt8(n))
        } else if n < 65536 {
            frame.append(0x80 | 126)
            frame.append(contentsOf: [UInt8(n >> 8 & 0xff), UInt8(n & 0xff)])
        } else {
            frame.append(0x80 | 127)
            frame.append(contentsOf: (0..<8).reversed().map { UInt8(n >> ($0 * 8) & 0xff) })
        }
        var mask = [UInt8](repeating: 0, count: 4)
        _ = SecRandomCopyBytes(kSecRandomDefault, 4, &mask)
        frame.append(contentsOf: mask)
        frame.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset % 4] })
        t.write(frame, timeout: 30) { [weak self] error in
            if error != nil { self?.queue.async { self?.finish() } }
        }
    }

    private func finish() {
        guard !closed else { return }
        closed = true
        open = false
        task?.cancel()
        task = nil
        DispatchQueue.main.async { self.onClose?() }
    }
}
