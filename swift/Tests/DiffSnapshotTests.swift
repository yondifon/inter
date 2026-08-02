import SwiftUI
import XCTest
@testable import Inter

/// Temporary: renders the diff view to a PNG so the layout can be eyeballed.
final class DiffSnapshotTests: XCTestCase {
    @MainActor func testRenderDiff() throws {
        let raw = """
        {
          "tool_name": "Edit",
          "tool_input": {
            "file_path": "/repo/internal/repo/agents.go",
            "old_string": "func (r *Repo) Agents(ctx context.Context) ([]Agent, error) {\\n\\trows, err := r.db.QueryContext(ctx, `\\n\\t\\tSELECT id, name, last_run_at, next_run_at\\n\\t\\tFROM agents\\n\\t\\tORDER BY name\\n\\t`)\\n\\tif err != nil {\\n\\t\\treturn nil, err\\n\\t}\\n\\tdefer rows.Close()\\n\\tif lastRunAt.Valid {\\n\\t\\ta.LastRunAt = parseTime(lastRunAt.String)\\n\\t}",
            "new_string": "func (r *Repo) Agents(ctx context.Context) ([]Agent, error) {\\n\\trows, err := r.db.QueryContext(ctx, `\\n\\t\\tSELECT id, name, CAST(last_run_at AS TEXT), CAST(next_run_at AS TEXT)\\n\\t\\tFROM agents\\n\\t\\tORDER BY name\\n\\t`)\\n\\tif err != nil {\\n\\t\\treturn nil, err\\n\\t}\\n\\tdefer rows.Close()\\n\\tif lastRunAt.Valid {\\n\\t\\ta.LastRunAt = parseSQLiteTime(lastRunAt.String)\\n\\t}"
          }
        }
        """
        let change = try XCTUnwrap(FileChange(rawEvent: raw))
        let view = VStack(alignment: .leading, spacing: 10) {
            Text("Edit file   …/internal/repo/agents.go   2 lines changed")
                .font(.system(size: 12, weight: .medium, design: .monospaced))
            FileChangeView(change: change)
            Button("Show raw event") {}.buttonStyle(.plain)
                .font(.system(size: 10)).foregroundStyle(.tertiary)
        }
        .padding(14)
        .frame(width: 720)
        .background(Surface.panel)

        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage)
        let data = try XCTUnwrap(image.tiffRepresentation)
        let png = try XCTUnwrap(NSBitmapImageRep(data: data)?.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: "/tmp/claude-501/-Users-malico-desgn-inter/f675e199-06e9-456f-ac25-af84f5cd255c/scratchpad/diff.png"))
    }
}
