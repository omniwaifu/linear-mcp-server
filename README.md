# Linear MCP Server

~~**IMPORTANT NOTE:** This MCP Server is now deprecated and is no longer being maintained. I recommend you use the official Linear remote MCP server here: https://linear.app/changelog/2025-05-01-mcp (https://mcp.linear.app/sse)~~

Linear's MCP isn't open source, and thus sucks.

A [Model Context Protocol](https://github.com/modelcontextprotocol) server for the [Linear API](https://developers.linear.app/docs/graphql/working-with-the-graphql-api).

This server provides comprehensive integration with Linear's issue tracking system through MCP, allowing LLMs to interact with Linear issues, attachments, and project management features.

## Installation

1. Clone and build the server:

```bash
git clone <repository-url>
cd linear-mcp-server
bun install
bun run build
```

2. Create or get a Linear API key for your team: [https://linear.app/YOUR-TEAM/settings/api](https://linear.app/YOUR-TEAM/settings/api)

3. Add server config to Claude Desktop:
   - MacOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`
   - Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "linear": {
      "command": "node",
      "args": ["/path/to/linear-mcp-server/build/index.js"],
      "env": {
        "LINEAR_API_KEY": "your_linear_api_key_here"
      }
    }
  }
}
```

Replace `/path/to/linear-mcp-server` with the actual path to your cloned repository.

## Components

### Tools

1. **`linear_create_issue`**: Create comprehensive Linear issues
   - Required inputs:
     - `title` (string): Issue title
     - `teamId` (string): Team ID to create issue in
   - Optional inputs:
     - `description` (string): Issue description (markdown supported)
     - `priority` (number, 0-4): Priority level (0=none, 1=urgent, 2=high, 3=normal, 4=low)
     - `status` (string): Initial status/state ID
     - `parentId` (string): Parent issue ID (to create sub-issues)
     - `assigneeId` (string): User ID to assign this issue to
     - `labels` (string[]): Array of label IDs to add to this issue
     - `estimate` (number): Story points estimate
     - `dueDate` (string): Due date in ISO 8601 format (YYYY-MM-DD)
     - `projectId` (string): Project ID to add this issue to
     - `cycleId` (string): Cycle ID to add this issue to
     - `subIssueSortOrder` (number): Position in parent's sub-issue list (for sub-issues)
     - `createAsUser` (string): Custom username for OAuth actor authorization
     - `displayIconUrl` (string): Custom avatar URL for OAuth actor authorization

2. **`linear_update_issue`**: Update existing issues with comprehensive field support
   - Required inputs:
     - `id` (string): Issue ID to update
   - Optional inputs:
     - `title` (string): New title
     - `description` (string): New description
     - `priority` (number, 0-4): New priority (0=none, 1=urgent, 2=high, 3=normal, 4=low)
     - `status` (string): New status/state ID
     - `assigneeId` (string): New assignee user ID (use null to unassign)
     - `labels` (string[]): New array of label IDs (replaces existing labels)
     - `estimate` (number): New story points estimate
     - `dueDate` (string): New due date in ISO 8601 format (YYYY-MM-DD)
     - `projectId` (string): New project ID
     - `cycleId` (string): New cycle ID

3. **`linear_search_issues`**: Search issues with flexible filtering
   - Optional inputs:
     - `query` (string): Text to search in title/description
     - `teamId` (string): Filter by team
     - `status` (string): Filter by status
     - `assigneeId` (string): Filter by assignee
     - `labels` (string[]): Filter by labels
     - `priority` (number): Filter by priority
     - `estimate` (number): Filter by estimate points
     - `includeArchived` (boolean): Include archived issues
     - `limit` (number, default: 10): Max results

4. **`linear_get_user_issues`**: Get issues assigned to a user
   - Optional inputs:
     - `userId` (string): User ID (omit for authenticated user)
     - `includeArchived` (boolean): Include archived issues
     - `limit` (number, default: 50): Max results

5. **`linear_add_comment`**: Add comments to issues
   - Required inputs:
     - `issueId` (string): Issue ID to comment on
     - `body` (string): Comment text (markdown supported)
   - Optional inputs:
     - `createAsUser` (string): Custom username
     - `displayIconUrl` (string): Custom avatar URL

6. **`linear_create_attachment`**: Create attachments for issues
   - Required inputs:
     - `issueId` (string): ID of the issue to attach to
     - `title` (string): Attachment title
     - `url` (string): URL of the external resource (must be unique per issue)
   - Optional inputs:
     - `subtitle` (string): Attachment subtitle (supports formatting variables)
     - `iconUrl` (string): Icon URL for the attachment
     - `metadata` (object): Metadata object for the attachment

7. **`linear_update_attachment`**: Update existing attachments
   - Required inputs:
     - `id` (string): Attachment ID
   - Optional inputs:
     - `title` (string): New attachment title
     - `subtitle` (string): New attachment subtitle (supports formatting variables)
     - `metadata` (object): New metadata object for the attachment

8. **`linear_get_teams`**: List all teams in the organization
   - No inputs required
   - Returns team IDs, names, keys, and descriptions

9. **`linear_get_users`**: List all users in the organization
   - No inputs required
   - Returns user IDs, names, display names, emails, and status

10. **`linear_get_workflow_states`**: List all workflow states (issue statuses)
    - No inputs required
    - Returns state IDs, names, colors, and types

11. **`linear_get_projects`**: List all projects in the organization
    - No inputs required
    - Returns project IDs, names, descriptions, states, and progress

12. **`linear_get_labels`**: List all issue labels
    - No inputs required
    - Returns label IDs, names, colors, and descriptions

13. **`linear_get_cycles`**: List all cycles (sprints)
    - No inputs required
    - Returns cycle IDs, names, numbers, and date ranges

### Resources

- `linear-issue:///{issueId}` - View individual issue details
- `linear-team:///{teamId}/issues` - View team issues
- `linear-user:///{userId}/assigned` - View user's assigned issues
- `linear-organization:` - View organization info
- `linear-viewer:` - View current user context

## Usage Examples

Some example prompts you can use with Claude Desktop to interact with Linear:

### Issue Management

1. "Create a high-priority bug report for the authentication system with 5 story points and assign it to user-123"
2. "Create a sub-issue under issue ABC-456 for implementing JWT token validation"
3. "Update issue DEF-789 to move it to the current sprint and set due date to next Friday"
4. "Find all urgent issues assigned to me that are due this week"

### Project Organization

5. "Show me all issues in the mobile project that are in progress"
6. "Create an issue for API refactoring, add it to the backend project, assign 8 story points, and add the 'refactor' and 'api' labels"
7. "What's the current workload for the mobile team across all active cycles?"

### Attachments and Documentation

8. "Add a Figma design attachment to issue XYZ-123 with the link to our auth flow mockups"
9. "Update the attachment on issue ABC-456 to reflect that the external service is now resolved"

### Advanced Queries

10. "Find all issues labeled 'bug' and 'frontend' that have more than 3 story points"
11. "Show me recent updates on all issues in the authentication project"
12. "List all sub-issues under the main authentication epic"

## Features

### Complete Issue Management

- Create issues with full metadata (assignee, labels, estimates, due dates, projects, cycles)
- Create sub-issues with proper parent-child relationships and sorting
- Update any aspect of existing issues
- Comprehensive search and filtering capabilities

### Project Organization

- Associate issues with projects and cycles (sprints)
- Set story point estimates for sprint planning
- Organize issues with labels and priorities
- Track due dates and deadlines

### Team Collaboration

- Assign issues to team members
- Add comments with markdown formatting
- Create and manage attachments to external resources
- Support for OAuth actor authorization (custom usernames/avatars)

### Advanced Functionality

- Sub-issue creation and management with custom positioning
- Attachment management with metadata and formatting variables
- Comprehensive search across all issue fields and relationships
- Support for archived issues and advanced filtering

## Development

1. Install dependencies:

```bash
bun install
```

2. Configure Linear API key in `.env`:

```bash
LINEAR_API_KEY=your_api_key_here
```

3. Build the server:

```bash
bun run build
```

For development with auto-rebuild:

```bash
bun run watch
```

## API Coverage

This server implements comprehensive Linear API functionality including:

- **Issues**: Full CRUD operations with all metadata fields
- **Sub-issues**: Parent-child relationships with positioning
- **Comments**: Rich text comments with custom attribution
- **Attachments**: External resource linking with metadata
- **Search**: Advanced filtering and querying capabilities
- **Projects**: Association and management
- **Cycles**: Sprint/iteration management
- **Labels**: Tagging and categorization
- **Assignments**: User assignment and workload management
- **Estimates**: Story point tracking for sprint planning

## TODO

Missing tools that would be valuable to implement:

### Projects Management

- ~~`linear_get_projects` - List all projects~~ **Implemented**
- `linear_create_project` - Create new project
- `linear_update_project` - Update project details
- `linear_get_project_issues` - Get issues in a specific project

### Labels/Tags Management

- ~~`linear_get_labels` - List all available labels~~ **Implemented**
- `linear_create_label` - Create new label

### Workflow States

- ~~`linear_get_workflow_states` - List all workflow states (status options)~~ **Implemented**
- `linear_get_team_workflow_states` - Get states for specific team

### Cycles Management

- ~~`linear_get_cycles` - List cycles (sprints)~~ **Implemented**
- `linear_create_cycle` - Create new cycle
- `linear_get_cycle_issues` - Get issues in a cycle

### File Upload

- `linear_upload_file` - Upload file and get URL for attachments

### Advanced Issue Operations

- `linear_archive_issue` - Archive an issue
- `linear_unarchive_issue` - Unarchive an issue
- `linear_duplicate_issue` - Duplicate an issue

### Team Management

- ~~`linear_get_teams` - List all teams~~ **Implemented**
- `linear_get_team_members` - Get members of a team

### Users and Organization

- ~~`linear_get_users` - List organization users~~ **Implemented**
- `linear_get_user` - Get specific user details

### Customer Management (for Linear's CRM features)

- `linear_create_customer` - Create customer records
- `linear_update_customer` - Update customer information
- `linear_create_customer_need` - Link customer requests to issues

### Webhooks (for advanced integrations)

- ~~`linear_create_webhook` - Set up webhook endpoints~~ **Available in Linear API**
- ~~`linear_list_webhooks` - List existing webhooks~~ **Available in Linear API**
- ~~`linear_delete_webhook` - Remove webhook endpoints~~ **Available in Linear API**

### What We Actually Implemented

**Core Issue Management:**

- ~~`linear_create_issue`~~ **Full implementation with all 15+ parameters**
- ~~`linear_update_issue`~~ **Full implementation with all 11 parameters**
- ~~`linear_search_issues`~~ **Advanced filtering and querying**
- ~~`linear_get_user_issues`~~ **User assignment queries**
- ~~`linear_add_comment`~~ **Rich text comments**

**Sub-Issues:**

- ~~`parentId` support~~ **Create sub-issues with parent relationships**
- ~~`subIssueSortOrder`~~ **Position sub-issues within parent**

**Issue Metadata:**

- ~~`assigneeId`~~ **Assign issues to users**
- ~~`labels`~~ **Add/update labels on issues**
- ~~`estimate`~~ **Story points for sprint planning**
- ~~`dueDate`~~ **Due date tracking**
- ~~`projectId`~~ **Associate with projects**
- ~~`cycleId`~~ **Associate with cycles/sprints**
- ~~`priority`~~ **Priority levels (0-4)**

**Attachments:**

- ~~`linear_create_attachment`~~ **Link external resources**
- ~~`linear_update_attachment`~~ **Update attachment metadata**

**Discovery Functions:**

- ~~`linear_get_teams`~~ **List all teams for finding team IDs**
- ~~`linear_get_users`~~ **List all users for finding user IDs**
- ~~`linear_get_workflow_states`~~ **List workflow states for status IDs**
- ~~`linear_get_projects`~~ **List all projects for project IDs**
- ~~`linear_get_labels`~~ **List all labels for label IDs**
- ~~`linear_get_cycles`~~ **List all cycles for cycle IDs**

**OAuth Features:**

- ~~`createAsUser` and `displayIconUrl`~~ **Custom user attribution**

### Notes on Missing Features

**We've now implemented all the essential discovery functions!** The remaining TODOs are mainly:

- **Creation/management functions** for Linear entities (projects, cycles, labels, teams)
- **Advanced operations** like archiving, file upload, customer management
- **Webhook management** (the GraphQL API supports these, just need MCP wrappers)

Your Linear MCP server is now **production-ready** with comprehensive issue management and all the discovery functions needed to use it effectively without manually hunting for IDs.

## License

This MCP server is licensed under the MIT License. This means you are free to use, modify, and distribute the software, subject to the terms and conditions of the MIT License. For more details, please see the LICENSE file in the project repository.
