import SwiftUI

/// How a block of code is read. Not one case per language: the only distinctions
/// a trace needs are where a comment starts, what quotes a string, and which
/// words are structure — which sorts every language the app meets into four
/// families. Anything unrecognised stays plain, because mis-tinted prose reads
/// worse than untinted code.
enum CodeLanguage: Equatable {
    /// `//`, `/* */`, and braces: Swift, TypeScript, Go, Rust, Java, C.
    case cFamily
    /// `#` to the end of the line: shell, TOML, YAML, Makefiles.
    case hashFamily
    /// Strings, numbers, and three literals. No comments.
    case json
    /// Headings and inline code — the two marks worth a reader's eye in prose.
    case markdown
    case none

    /// The word on a fence — ```` ```ts ```` — ignoring anything after it, since a
    /// fence may carry a title or a highlight range.
    init(fence: String?) {
        let name = fence?.lowercased()
            .split(whereSeparator: { $0 == " " || $0 == ":" || $0 == "," })
            .first
            .map(String.init)
        self = CodeLanguage.byName[name ?? ""] ?? .none
    }

    /// A path names its language with its extension; a few files name it with the
    /// whole filename instead.
    init(path: String?) {
        let file = (path?.split(separator: "/").last).map { String($0).lowercased() } ?? ""
        let name = file.contains(".") ? String(file.split(separator: ".").last ?? "") : file
        self = CodeLanguage.byName[name] ?? .none
    }

    /// Fence words and file extensions share one table — they are the same names.
    private static let byName: [String: CodeLanguage] = {
        var table: [String: CodeLanguage] = [:]
        for name in [
            "swift", "ts", "typescript", "tsx", "js", "javascript", "jsx", "mjs", "cjs",
            "go", "rust", "rs", "java", "kt", "kotlin", "scala", "dart", "php", "cs",
            "c", "h", "cc", "cpp", "hpp", "m", "mm", "css", "scss", "less", "proto",
        ] { table[name] = .cFamily }
        for name in [
            "py", "python", "rb", "ruby", "sh", "bash", "zsh", "shell", "fish",
            "yaml", "yml", "toml", "ini", "conf", "makefile", "make", "mk",
            "dockerfile", "gitignore", "env", "r", "pl", "ps1",
        ] { table[name] = .hashFamily }
        for name in ["json", "jsonc", "json5"] { table[name] = .json }
        for name in ["md", "markdown"] { table[name] = .markdown }
        return table
    }()
}

struct CodeSpan: Equatable {
    enum Kind: Equatable { case plain, comment, string, number, keyword, type }

    let kind: Kind
    let text: String
}

enum SyntaxHighlighter {
    /// One left-to-right pass, no backtracking: comments and strings win over
    /// everything, then numbers, then words. The spans concatenate back to the
    /// source exactly — a highlighter that drops a character costs the reader the
    /// thing they opened the row for.
    static func spans(_ source: String, language: CodeLanguage) -> [CodeSpan] {
        guard language != .none, !source.isEmpty else {
            return source.isEmpty ? [] : [CodeSpan(kind: .plain, text: source)]
        }
        let chars = Array(source)
        let words = keywords(language)
        var spans: [CodeSpan] = []
        var plain: [Character] = []
        var index = 0

        func flushPlain() {
            guard !plain.isEmpty else { return }
            spans.append(CodeSpan(kind: .plain, text: String(plain)))
            plain = []
        }

        func emit(_ kind: CodeSpan.Kind, through end: Int) {
            flushPlain()
            spans.append(CodeSpan(kind: kind, text: String(chars[index..<end])))
            index = end
        }

        while index < chars.count {
            if language == .markdown, isLineStart(chars, index), let end = headingEnd(chars, from: index) {
                emit(.keyword, through: end)
            } else if let end = commentEnd(chars, from: index, language: language) {
                emit(.comment, through: end)
            } else if let end = stringEnd(chars, from: index, language: language) {
                emit(.string, through: end)
            } else if language != .markdown, chars[index].isNumber {
                // Digits inside a name are consumed by the word branch below, so
                // a digit reached here always opens a literal. Markdown is prose,
                // not source — a year in a sentence is not a numeric literal.
                emit(.number, through: numberEnd(chars, from: index))
            } else if isWordStart(chars[index]) {
                let end = wordEnd(chars, from: index)
                let word = String(chars[index..<end])
                if words.contains(word) {
                    emit(.keyword, through: end)
                } else if language == .cFamily, word.first?.isUppercase == true {
                    // A capitalised name is a type by convention in every cFamily
                    // member — Swift, TypeScript, Go, Rust, Java, C — so this reads
                    // right without a per-language type table.
                    emit(.type, through: end)
                } else {
                    plain.append(contentsOf: chars[index..<end])
                    index = end
                }
            } else {
                plain.append(chars[index])
                index += 1
            }
        }
        flushPlain()
        return spans
    }

    private static func commentEnd(_ chars: [Character], from start: Int, language: CodeLanguage) -> Int? {
        switch language {
        case .cFamily:
            if matches(chars, start, "//") { return lineEnd(chars, from: start) }
            guard matches(chars, start, "/*") else { return nil }
            var index = start + 2
            while index < chars.count, !matches(chars, index, "*/") { index += 1 }
            return min(index + 2, chars.count)
        case .hashFamily:
            return chars[start] == "#" ? lineEnd(chars, from: start) : nil
        case .json, .markdown, .none:
            return nil
        }
    }

    private static func isLineStart(_ chars: [Character], _ index: Int) -> Bool {
        index == 0 || chars[index - 1] == "\n"
    }

    /// One to six `#` then a space opens an ATX heading; the whole line is the
    /// heading, the same width a reader's eye gives it.
    private static func headingEnd(_ chars: [Character], from start: Int) -> Int? {
        var index = start
        while index < chars.count, index - start < 6, chars[index] == "#" { index += 1 }
        guard index > start, index < chars.count, chars[index] == " " else { return nil }
        return lineEnd(chars, from: start)
    }

    private static func stringEnd(_ chars: [Character], from start: Int, language: CodeLanguage) -> Int? {
        let quote = chars[start]
        guard quotes(language).contains(quote) else { return nil }
        // Swift and Python both write a block of text as three quotes, and it is
        // the one quoted form that holds newlines without being unterminated.
        let fence = String(repeating: quote, count: 3)
        if language != .json, matches(chars, start, fence) {
            var index = start + 3
            while index < chars.count, !matches(chars, index, fence) { index += 1 }
            return min(index + 3, chars.count)
        }
        var index = start + 1
        while index < chars.count {
            let char = chars[index]
            if char == "\\" {
                index += 2
                continue
            }
            if char == quote { return index + 1 }
            // An apostrophe in prose is not an opening quote. Ending at the line
            // keeps one of them from tinting the rest of the block; a backtick
            // template is the exception, written across lines on purpose.
            if char == "\n", quote != "`" { return index }
            index += 1
        }
        return chars.count
    }

    private static func numberEnd(_ chars: [Character], from start: Int) -> Int {
        var index = start
        while index < chars.count {
            let char = chars[index]
            if isWordPart(char) {
                index += 1
            } else if char == ".", index + 1 < chars.count, chars[index + 1].isNumber {
                // A dot belongs to the literal only when a digit follows, so `1.5`
                // holds together and `0..<n` stops at the range operator.
                index += 2
            } else {
                break
            }
        }
        return index
    }

    private static func lineEnd(_ chars: [Character], from start: Int) -> Int {
        var index = start
        while index < chars.count, chars[index] != "\n" { index += 1 }
        return index
    }

    private static func wordEnd(_ chars: [Character], from start: Int) -> Int {
        var index = start
        while index < chars.count, isWordPart(chars[index]) { index += 1 }
        return index
    }

    private static func isWordStart(_ char: Character) -> Bool {
        char.isLetter || char == "_" || char == "$"
    }

    private static func isWordPart(_ char: Character) -> Bool {
        char.isLetter || char.isNumber || char == "_" || char == "$"
    }

    private static func matches(_ chars: [Character], _ index: Int, _ text: String) -> Bool {
        let needle = Array(text)
        guard index + needle.count <= chars.count else { return false }
        return !zip(needle, chars[index...]).contains { $0 != $1 }
    }

    private static func quotes(_ language: CodeLanguage) -> Set<Character> {
        switch language {
        case .cFamily: ["\"", "'", "`"]
        case .hashFamily: ["\"", "'"]
        case .markdown: ["`"]
        case .json, .none: ["\""]
        }
    }

    /// One set per family rather than per language. A word that is structure in
    /// one member and a name in another — `type`, `range` — is rare enough in a
    /// trace that the union reads better than three near-identical tables.
    private static func keywords(_ language: CodeLanguage) -> Set<String> {
        switch language {
        case .cFamily: cFamilyKeywords
        case .hashFamily: hashFamilyKeywords
        case .json: ["true", "false", "null"]
        case .markdown, .none: []
        }
    }

    // "of", "range", "select", "template", and "union" are real keywords in some
    // cFamily member, but they are also ordinary Swift/TypeScript identifiers —
    // an argument label, a variable, a type name — and those two languages are
    // read here far more often than the ones that reserve those words.
    private static let cFamilyKeywords: Set<String> = [
        "abstract", "any", "as", "associatedtype", "async", "await", "break", "case",
        "catch", "chan", "class", "const", "constexpr", "continue", "crate", "declare",
        "default", "defer", "deinit", "delete", "do", "dyn", "else", "enum", "export",
        "extends", "extension", "fallthrough", "false", "fileprivate", "final", "finally",
        "fn", "for", "from", "func", "function", "goto", "guard", "if", "impl",
        "implements", "import", "in", "indirect", "infer", "init", "inline", "inout",
        "instanceof", "interface", "internal", "is", "keyof", "lazy", "let",
        "match", "mod", "mut", "mutating", "namespace", "new", "nil", "null",
        "open", "operator", "override", "package", "private", "protocol", "pub",
        "public", "readonly", "repeat", "required", "rethrows", "return",
        "satisfies", "self", "sizeof", "some", "static", "struct", "subscript",
        "super", "switch", "this", "throw", "throws", "trait", "true", "try",
        "type", "typedef", "typealias", "typeof", "undefined", "unowned", "unsafe",
        "use", "using", "var", "void", "volatile", "weak", "where", "while", "willSet",
        "didSet", "yield",
    ]

    // "source" is a real bash builtin but also this app's own name for the text a
    // reader is looking at — the far more common thing to see it modifying Python
    // or shell content — so it stays a plain identifier here.
    private static let hashFamilyKeywords: Set<String> = [
        "and", "as", "assert", "async", "await", "break", "case", "class",
        "continue", "declare", "def", "del", "do", "done", "elif", "else", "elsif",
        "end", "esac", "except", "exit", "export", "false", "False", "fi", "finally",
        "for", "from", "function", "global", "if", "import", "in", "is", "lambda",
        "local", "module", "nil", "none", "None", "nonlocal", "not", "or", "pass",
        "raise", "readonly", "require", "return", "self", "shift", "then",
        "trap", "true", "True", "try", "unless", "until", "while", "with",
        "yield",
    ]
}

enum CodeStyle {
    private final class Box {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }

    /// A row's body re-runs on redraws that have nothing to do with its own
    /// text — scrolling, a sibling's state change — so the highlighted result
    /// is cached by its exact input instead of retokenized every time. Bounded
    /// by both count and text size so one huge diff block cannot pin the rest.
    private static let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.countLimit = 500
        cache.totalCostLimit = 20_000_000
        return cache
    }()

    static func highlighted(_ text: String, language: CodeLanguage) -> AttributedString {
        let key = "\(language)\u{0}\(text)" as NSString
        if let boxed = cache.object(forKey: key) { return boxed.value }

        var result = AttributedString()
        for span in SyntaxHighlighter.spans(text, language: language) {
            var piece = AttributedString(span.text)
            // Plain runs carry no color so they inherit whatever the row set — a
            // dimmed context line stays dimmed.
            if let tint = tint(span.kind) { piece.foregroundColor = tint }
            result.append(piece)
        }
        cache.setObject(Box(result), forKey: key, cost: text.utf8.count)
        return result
    }

    private static func tint(_ kind: CodeSpan.Kind) -> Color? {
        switch kind {
        case .plain: nil
        case .comment: SyntaxTint.comment
        case .string: SyntaxTint.string
        case .number: SyntaxTint.number
        case .keyword: SyntaxTint.keyword
        case .type: SyntaxTint.type
        }
    }
}
