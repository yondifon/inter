import XCTest

@testable import Inter

final class MCPConfigSanitizerTests: XCTestCase {
    private func parsed(_ text: String) -> [String: Any]? {
        guard let data = MCPConfigInjector.sanitizeJSONC(text).data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    /// The bug: the trailing-comma pass used to run over the whole document, so any
    /// comma followed by whitespace and then `}` or `]` was deleted — including inside
    /// a string value. The sanitizer rewrites `~/.claude.json` in place, so a mangled
    /// value here is a damaged config. Every value must survive intact.
    func testCommasInsideStringValuesSurvive() {
        let text = #"""
        {
          "mcpServers": {
            "inter": { "type": "http", "url": "http://127.0.0.1:7391/mcp" }
          },
          "brace": "one, } two",
          "bracket": "three, ] four",
          "newline": "five,\n} six",
          "argv": ["--flag", "a, ]"]
        }
        """#

        let root = parsed(text)
        XCTAssertEqual(root?["brace"] as? String, "one, } two")
        XCTAssertEqual(root?["bracket"] as? String, "three, ] four")
        XCTAssertEqual(root?["newline"] as? String, "five,\n} six")
        XCTAssertEqual(root?["argv"] as? [String], ["--flag", "a, ]"])
    }

    /// An escaped quote must not be read as the closing quote. If it were, the scanner
    /// would think it had left the string and start editing the rest of it — and a
    /// value ending in a backslash must not swallow its own closing quote either.
    func testEscapedQuotesDoNotDesyncTheScanner() {
        let text = #"""
        {
          "quoted": "he said \"hi, }\" and left",
          "backslash": "ends with a backslash \\",
          "after": "plain, ] value"
        }
        """#

        let root = parsed(text)
        XCTAssertEqual(root?["quoted"] as? String, "he said \"hi, }\" and left")
        XCTAssertEqual(root?["backslash"] as? String, "ends with a backslash \\")
        XCTAssertEqual(root?["after"] as? String, "plain, ] value")
    }

    /// Genuine trailing commas still go — nested, at the end of an array, and separated
    /// from the closing brace by a newline or a line comment. Without that, real JSONC
    /// configs stop parsing and `installJSON` refuses the file.
    func testTrailingCommasAreStillRemoved() {
        let text = """
        {
          // inter's block
          "mcpServers": {
            "inter": { "type": "http", "url": "u", },
          },
          "list": [
            1,
            2, // last item
          ],
        }
        """

        let root = parsed(text)
        let servers = root?["mcpServers"] as? [String: Any]
        XCTAssertEqual((servers?["inter"] as? [String: Any])?["url"] as? String, "u")
        XCTAssertEqual(root?["list"] as? [Int], [1, 2])
    }

    /// Strict JSON with nothing to strip comes back byte-identical, commas inside string
    /// values included. This is the assertion the old regex failed.
    func testCleanJSONIsUnchangedByteForByte() {
        let text = #"""
        {
          "mcpServers": {
            "inter": { "type": "http", "url": "http://127.0.0.1:7391/mcp" }
          },
          "history": ["a, ]", "b, }"],
          "escaped": "q \" , } end"
        }
        """#

        XCTAssertEqual(MCPConfigInjector.sanitizeJSONC(text), text)
    }
}
