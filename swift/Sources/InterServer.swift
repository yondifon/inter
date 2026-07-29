import Foundation

enum InterServer {
    static let port = 7331
    static let baseURL = "http://127.0.0.1:\(port)"
    static let mcpURL = "\(baseURL)/mcp"
    static func api(_ path: String) -> URL { URL(string: "\(baseURL)/api/\(path)")! }
}
