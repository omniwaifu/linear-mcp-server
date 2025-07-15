#!/usr/bin/env node

import {
  LinearClient,
  LinearDocument,
  Issue,
  User,
  WorkflowState,
  IssueLabel,
} from "@linear/sdk";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequest,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  Tool,
  ResourceTemplate,
  Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import dotenv from "dotenv";
import { z } from "zod";

interface CreateIssueArgs {
  title: string;
  teamId: string;
  description?: string;
  priority?: number;
  status?: string;
  parentId?: string;
  assigneeId?: string;
  labels?: string[];
  estimate?: number;
  dueDate?: string;
  projectId?: string;
  cycleId?: string;
  subIssueSortOrder?: number;
  createAsUser?: string;
  displayIconUrl?: string;
}

interface UpdateIssueArgs {
  id: string;
  title?: string;
  description?: string;
  priority?: number;
  status?: string;
  assigneeId?: string;
  labels?: string[];
  estimate?: number;
  dueDate?: string;
  projectId?: string;
  cycleId?: string;
}

interface SearchIssuesArgs {
  query?: string;
  teamId?: string;
  limit?: number;
  status?: string;
  assigneeId?: string;
  labels?: string[];
  priority?: number;
  estimate?: number;
  includeArchived?: boolean;
}

interface GetUserIssuesArgs {
  userId?: string;
  includeArchived?: boolean;
  limit?: number;
}

interface AddCommentArgs {
  issueId: string;
  body: string;
  createAsUser?: string;
  displayIconUrl?: string;
}

interface CreateAttachmentArgs {
  issueId: string;
  title: string;
  subtitle?: string;
  url: string;
  iconUrl?: string;
  metadata?: Record<string, any>;
}

interface UpdateAttachmentArgs {
  id: string;
  title?: string;
  subtitle?: string;
  metadata?: Record<string, any>;
}

interface RateLimiterMetrics {
  totalRequests: number;
  requestsInLastHour: number;
  averageRequestTime: number;
  queueLength: number;
  lastRequestTime: number;
}

interface LinearIssueResponse {
  identifier: string;
  title: string;
  priority: number | null;
  status: string | null;
  stateName?: string;
  url: string;
}

class RateLimiter {
  public readonly requestsPerHour = 1400;
  private lastRequestTime = 0;
  private readonly minDelayMs = 3600000 / this.requestsPerHour;
  private requestTimes: number[] = [];
  private requestTimestamps: number[] = [];

  async enqueue<T>(fn: () => Promise<T>, operation?: string): Promise<T> {
    const startTime = Date.now();
    const timeSinceLastRequest = startTime - this.lastRequestTime;

    if (timeSinceLastRequest < this.minDelayMs) {
      const waitTime = this.minDelayMs - timeSinceLastRequest;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }

    try {
      this.lastRequestTime = Date.now();

      // Add timeout wrapper to prevent hanging
      const timeoutMs = 30000; // 30 second timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(
              `Request timeout after ${timeoutMs}ms${operation ? ` for ${operation}` : ""}`,
            ),
          );
        }, timeoutMs);
      });

      const result = await Promise.race([fn(), timeoutPromise]);
      const endTime = Date.now();

      this.trackRequest(startTime, endTime, operation);
      return result;
    } catch (error) {
      console.error(
        `[Linear API] Error in request${operation ? ` for ${operation}` : ""}: `,
        error,
      );
      throw error;
    }
  }

  async batch<T>(
    items: any[],
    batchSize: number,
    fn: (item: any) => Promise<T>,
    operation?: string,
  ): Promise<T[]> {
    const batches = [];
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      batches.push(
        Promise.all(
          batch.map((item) => this.enqueue(() => fn(item), operation)),
        ),
      );
    }

    const results = await Promise.all(batches);
    return results.flat();
  }

  private trackRequest(
    startTime: number,
    endTime: number,
    _operation?: string,
  ) {
    const duration = endTime - startTime;
    this.requestTimes.push(duration);
    this.requestTimestamps.push(startTime);

    // Keep only last hour of requests
    const oneHourAgo = Date.now() - 3600000;
    this.requestTimestamps = this.requestTimestamps.filter(
      (t) => t > oneHourAgo,
    );
    this.requestTimes = this.requestTimes.slice(-this.requestTimestamps.length);
  }

  getMetrics(): RateLimiterMetrics {
    const now = Date.now();
    const oneHourAgo = now - 3600000;
    const recentRequests = this.requestTimestamps.filter((t) => t > oneHourAgo);

    return {
      totalRequests: this.requestTimestamps.length,
      requestsInLastHour: recentRequests.length,
      averageRequestTime:
        this.requestTimes.length > 0
          ? this.requestTimes.reduce((a, b) => a + b, 0) /
            this.requestTimes.length
          : 0,
      queueLength: 0,
      lastRequestTime: this.lastRequestTime,
    };
  }
}

class LinearMCPClient {
  private client: LinearClient;
  public readonly rateLimiter: RateLimiter;

  constructor(apiKey: string) {
    if (!apiKey)
      throw new Error("LINEAR_API_KEY environment variable is required");
    this.client = new LinearClient({ apiKey });
    this.rateLimiter = new RateLimiter();
  }

  private async getIssueDetails(issue: Issue) {
    const [state, assignee, team] = await Promise.all([
      this.rateLimiter.enqueue(() =>
        issue.state ? issue.state : Promise.resolve(null),
      ),
      this.rateLimiter.enqueue(() =>
        issue.assignee ? issue.assignee : Promise.resolve(null),
      ),
      this.rateLimiter.enqueue(() =>
        issue.team ? issue.team : Promise.resolve(null),
      ),
    ]);

    return {
      state,
      assignee,
      team,
    };
  }

  private addMetricsToResponse(response: any) {
    const metrics = this.rateLimiter.getMetrics();
    const apiMetrics = {
      requestsInLastHour: metrics.requestsInLastHour,
      remainingRequests:
        this.rateLimiter.requestsPerHour - metrics.requestsInLastHour,
      averageRequestTime: `${Math.round(metrics.averageRequestTime)}ms`,
      queueLength: 0,
      lastRequestTime: new Date(metrics.lastRequestTime).toISOString(),
    };

    // Handle arrays differently to preserve their structure
    if (Array.isArray(response)) {
      // For arrays, add metadata as a property without spreading
      Object.defineProperty(response, "metadata", {
        value: { apiMetrics },
        enumerable: false,
        configurable: true,
      });
      return response;
    }

    // For objects, spread as before
    return {
      ...response,
      metadata: {
        ...response.metadata,
        apiMetrics,
      },
    };
  }

  async listIssues() {
    const result = await this.rateLimiter.enqueue(
      () =>
        this.client.issues({
          first: 50,
          orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
        }),
      "listIssues",
    );

    const issuesWithDetails = await this.rateLimiter.batch(
      result.nodes,
      5,
      async (issue) => {
        const details = await this.getIssueDetails(issue);
        return {
          uri: `linear-issue:///${issue.id}`,
          mimeType: "application/json",
          name: issue.title,
          description: `Linear issue ${issue.identifier}: ${issue.title}`,
          metadata: {
            identifier: issue.identifier,
            priority: issue.priority,
            status: details.state?.name,
            assignee: details.assignee?.name,
            team: details.team?.name,
          },
        };
      },
      "getIssueDetails",
    );

    return this.addMetricsToResponse(issuesWithDetails);
  }

  async getIssue(issueId: string) {
    const result = await this.rateLimiter.enqueue(() =>
      this.client.issue(issueId),
    );
    if (!result) throw new Error(`Issue ${issueId} not found`);

    const details = await this.getIssueDetails(result);

    return this.addMetricsToResponse({
      id: result.id,
      identifier: result.identifier,
      title: result.title,
      description: result.description,
      priority: result.priority,
      status: details.state?.name,
      assignee: details.assignee?.name,
      team: details.team?.name,
      url: result.url,
    });
  }

  async createIssue(args: CreateIssueArgs) {
    const issuePayload = await this.client.createIssue({
      title: args.title,
      teamId: args.teamId,
      description: args.description,
      priority: args.priority,
      stateId: args.status,
      parentId: args.parentId,
      assigneeId: args.assigneeId,
      labelIds: args.labels,
      estimate: args.estimate,
      dueDate: args.dueDate,
      projectId: args.projectId,
      cycleId: args.cycleId,
      subIssueSortOrder: args.subIssueSortOrder,
      createAsUser: args.createAsUser,
      displayIconUrl: args.displayIconUrl,
    });

    const issue = await issuePayload.issue;
    if (!issue) throw new Error("Failed to create issue");
    return issue;
  }

  async updateIssue(args: UpdateIssueArgs) {
    const issue = await this.client.issue(args.id);
    if (!issue) throw new Error(`Issue ${args.id} not found`);

    const updatePayload = await issue.update({
      title: args.title,
      description: args.description,
      priority: args.priority,
      stateId: args.status,
      assigneeId: args.assigneeId,
      labelIds: args.labels,
      estimate: args.estimate,
      dueDate: args.dueDate,
      projectId: args.projectId,
      cycleId: args.cycleId,
    });

    const updatedIssue = await updatePayload.issue;
    if (!updatedIssue) throw new Error("Failed to update issue");
    return updatedIssue;
  }

  async searchIssues(args: SearchIssuesArgs) {
    try {
      const result = await this.rateLimiter.enqueue(() =>
        this.client.issues({
          filter: this.buildSearchFilter(args),
          first: Math.min(args.limit || 10, 25), // Cap at 25 to avoid timeouts
          includeArchived: args.includeArchived,
        }),
      );

      if (!result?.nodes || result.nodes.length === 0) {
        return this.addMetricsToResponse([]);
      }

      const issuesWithDetails = await this.rateLimiter.batch(
        result.nodes,
        3, // Smaller batch size for reliability
        async (issue) => {
          try {
            const [state, assignee, labels] = await Promise.all([
              this.rateLimiter.enqueue(
                () => issue.state,
              ) as Promise<WorkflowState>,
              this.rateLimiter.enqueue(() => issue.assignee) as Promise<User>,
              this.rateLimiter.enqueue(() => issue.labels()) as Promise<{
                nodes: IssueLabel[];
              }>,
            ]);

            return {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description,
              priority: issue.priority,
              estimate: issue.estimate,
              status: state?.name || null,
              assignee: assignee?.name || null,
              labels:
                labels?.nodes?.map((label: IssueLabel) => label.name) || [],
              url: issue.url,
            };
          } catch (error) {
            // Return basic issue info if detailed fetch fails
            console.error(
              `Failed to get details for issue ${issue.identifier}:`,
              error instanceof Error ? error.message : String(error),
            );
            return {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description,
              priority: issue.priority,
              estimate: issue.estimate,
              status: "Unknown",
              assignee: null,
              labels: [],
              url: issue.url,
            };
          }
        },
      );

      return this.addMetricsToResponse(issuesWithDetails);
    } catch (error) {
      console.error(`Error in searchIssues: ${error}`);
      // Return structured error instead of throwing
      return this.addMetricsToResponse({
        error: true,
        message:
          error instanceof Error ? error.message : "Failed to search issues",
        issues: [],
      });
    }
  }

  async getUserIssues(args: GetUserIssuesArgs) {
    try {
      const user =
        args.userId && typeof args.userId === "string"
          ? await this.rateLimiter.enqueue(() =>
              this.client.user(args.userId as string),
            )
          : await this.rateLimiter.enqueue(() => this.client.viewer);

      const result = await this.rateLimiter.enqueue(() =>
        user.assignedIssues({
          first: args.limit || 50,
          includeArchived: args.includeArchived,
        }),
      );

      if (!result?.nodes || result.nodes.length === 0) {
        return this.addMetricsToResponse([]);
      }

      // Limit processing to avoid timeouts
      const limitedNodes = result.nodes.slice(
        0,
        Math.min(result.nodes.length, 20),
      );

      const issuesWithDetails = await this.rateLimiter.batch(
        limitedNodes,
        3, // Smaller batch size for reliability
        async (issue) => {
          try {
            const state = (await this.rateLimiter.enqueue(
              () => issue.state,
            )) as WorkflowState;
            return {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description,
              priority: issue.priority,
              stateName: state?.name || "Unknown",
              url: issue.url,
            };
          } catch (error) {
            // Return basic issue info if state fetch fails
            console.error(
              `Failed to get state for issue ${issue.identifier}:`,
              error instanceof Error ? error.message : String(error),
            );
            return {
              id: issue.id,
              identifier: issue.identifier,
              title: issue.title,
              description: issue.description,
              priority: issue.priority,
              stateName: "Unknown",
              url: issue.url,
            };
          }
        },
        "getUserIssues",
      );

      return this.addMetricsToResponse(issuesWithDetails);
    } catch (error) {
      console.error(`Error in getUserIssues: ${error}`);
      // Return structured error instead of throwing
      return this.addMetricsToResponse({
        error: true,
        message:
          error instanceof Error
            ? error.message
            : "Failed to fetch user issues",
        issues: [],
      });
    }
  }

  async addComment(args: AddCommentArgs) {
    const commentPayload = await this.client.createComment({
      issueId: args.issueId,
      body: args.body,
      createAsUser: args.createAsUser,
      displayIconUrl: args.displayIconUrl,
    });

    const comment = await commentPayload.comment;
    if (!comment) throw new Error("Failed to create comment");

    const issue = await comment.issue;
    return {
      comment,
      issue,
    };
  }

  async createAttachment(args: CreateAttachmentArgs) {
    const attachmentPayload = await this.client.createAttachment({
      issueId: args.issueId,
      title: args.title,
      subtitle: args.subtitle,
      url: args.url,
      iconUrl: args.iconUrl,
      metadata: args.metadata,
    });

    const attachment = await attachmentPayload.attachment;
    if (!attachment) throw new Error("Failed to create attachment");
    return attachment;
  }

  async updateAttachment(args: UpdateAttachmentArgs) {
    const updateData: any = {};
    if (args.title !== undefined) updateData.title = args.title;
    if (args.subtitle !== undefined) updateData.subtitle = args.subtitle;
    if (args.metadata !== undefined) updateData.metadata = args.metadata;

    const attachmentPayload = await this.client.updateAttachment(
      args.id,
      updateData,
    );

    const attachment = await attachmentPayload.attachment;
    if (!attachment) throw new Error("Failed to update attachment");
    return attachment;
  }

  async getTeams() {
    const result = await this.rateLimiter.enqueue(() => this.client.teams());
    const teams = result.nodes.map((team: any) => ({
      id: team.id,
      name: team.name,
      key: team.key,
      description: team.description || null,
    }));
    return this.addMetricsToResponse(teams);
  }

  async getUsers() {
    const result = await this.rateLimiter.enqueue(() => this.client.users());
    const users = result.nodes.map((user: any) => ({
      id: user.id,
      name: user.name,
      displayName: user.displayName,
      email: user.email,
      active: user.active,
      admin: user.admin,
    }));
    return this.addMetricsToResponse(users);
  }

  async getWorkflowStates() {
    const result = await this.rateLimiter.enqueue(() =>
      this.client.workflowStates(),
    );
    const states = result.nodes.map((state: any) => ({
      id: state.id,
      name: state.name,
      color: state.color,
      type: state.type,
      description: state.description || null,
    }));
    return this.addMetricsToResponse(states);
  }

  async getProjects() {
    const result = await this.rateLimiter.enqueue(() => this.client.projects());
    const projects = result.nodes.map((project: any) => ({
      id: project.id,
      name: project.name,
      description: project.description || null,
      state: project.state,
      progress: project.progress,
    }));
    return this.addMetricsToResponse(projects);
  }

  async getLabels() {
    const result = await this.rateLimiter.enqueue(() =>
      this.client.issueLabels(),
    );
    const labels = result.nodes.map((label: any) => ({
      id: label.id,
      name: label.name,
      color: label.color,
      description: label.description || null,
    }));
    return this.addMetricsToResponse(labels);
  }

  async getCycles() {
    const result = await this.rateLimiter.enqueue(() => this.client.cycles());
    const cycles = result.nodes.map((cycle: any) => ({
      id: cycle.id,
      name: cycle.name,
      number: cycle.number,
      startsAt: cycle.startsAt,
      endsAt: cycle.endsAt,
      completedAt: cycle.completedAt,
    }));
    return this.addMetricsToResponse(cycles);
  }

  async getTeamIssues(teamId: string) {
    const team = await this.rateLimiter.enqueue(() => this.client.team(teamId));
    if (!team) throw new Error(`Team ${teamId} not found`);

    const { nodes: issues } = await this.rateLimiter.enqueue(() =>
      team.issues(),
    );

    const issuesWithDetails = await this.rateLimiter.batch(
      issues,
      5,
      async (issue) => {
        const [state, assignee] = await Promise.all([
          this.rateLimiter.enqueue(() =>
            issue.state ? issue.state : Promise.resolve(null),
          ),
          this.rateLimiter.enqueue(() =>
            issue.assignee ? issue.assignee : Promise.resolve(null),
          ),
        ]);

        return {
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          description: issue.description,
          priority: issue.priority,
          status: state ? (state as any)?.name : null,
          assignee: assignee ? (assignee as any)?.name : null,
          url: issue.url,
        };
      },
    );

    return this.addMetricsToResponse(issuesWithDetails);
  }

  async getViewer() {
    const viewer = await this.client.viewer;
    const [teams, organization] = await Promise.all([
      viewer.teams(),
      this.client.organization,
    ]);

    return this.addMetricsToResponse({
      id: viewer.id,
      name: viewer.name,
      email: viewer.email,
      admin: viewer.admin,
      teams: teams.nodes.map((team) => ({
        id: team.id,
        name: team.name,
        key: team.key,
      })),
      organization: {
        id: organization.id,
        name: organization.name,
        urlKey: organization.urlKey,
      },
    });
  }

  async getOrganization() {
    const organization = await this.client.organization;
    const [teams, users] = await Promise.all([
      organization.teams(),
      organization.users(),
    ]);

    return this.addMetricsToResponse({
      id: organization.id,
      name: organization.name,
      urlKey: organization.urlKey,
      teams: teams.nodes.map((team) => ({
        id: team.id,
        name: team.name,
        key: team.key,
      })),
      users: users.nodes.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        admin: user.admin,
        active: user.active,
      })),
    });
  }

  private buildSearchFilter(args: SearchIssuesArgs): any {
    const filter: any = {};

    if (args.query) {
      filter.or = [
        { title: { contains: args.query } },
        { description: { contains: args.query } },
      ];
    }

    if (args.teamId) {
      filter.team = { id: { eq: args.teamId } };
    }

    if (args.status) {
      filter.state = { name: { eq: args.status } };
    }

    if (args.assigneeId) {
      filter.assignee = { id: { eq: args.assigneeId } };
    }

    if (args.labels && args.labels.length > 0) {
      filter.labels = {
        some: {
          name: { in: args.labels },
        },
      };
    }

    if (args.priority) {
      filter.priority = { eq: args.priority };
    }

    if (args.estimate) {
      filter.estimate = { eq: args.estimate };
    }

    return filter;
  }
}

const createIssueTool: Tool = {
  name: "linear_create_issue",
  description:
    "Creates a new Linear issue with comprehensive details. Use this to create tickets for tasks, bugs, or feature requests. Returns the created issue's identifier and URL. Required fields are title and teamId. Optional fields include description, priority (0-4), status, parentId (for sub-issues), assigneeId, labels (array of label IDs), estimate (story points), dueDate, projectId, cycleId, subIssueSortOrder, and OAuth actor fields.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Issue title" },
      teamId: { type: "string", description: "Team ID" },
      description: { type: "string", description: "Issue description" },
      priority: {
        type: "number",
        description:
          "Priority (0-4, where 0=none, 1=urgent, 2=high, 3=normal, 4=low)",
      },
      status: { type: "string", description: "Issue status/state ID" },
      parentId: {
        type: "string",
        description: "Parent issue ID (to create a sub-issue)",
      },
      assigneeId: {
        type: "string",
        description: "User ID to assign this issue to",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Array of label IDs to add to this issue",
      },
      estimate: { type: "number", description: "Story points estimate" },
      dueDate: {
        type: "string",
        description: "Due date in ISO 8601 format (YYYY-MM-DD)",
      },
      projectId: {
        type: "string",
        description: "Project ID to add this issue to",
      },
      cycleId: { type: "string", description: "Cycle ID to add this issue to" },
      subIssueSortOrder: {
        type: "number",
        description: "Position in parent's sub-issue list (for sub-issues)",
      },
      createAsUser: {
        type: "string",
        description: "Custom username for OAuth actor authorization",
      },
      displayIconUrl: {
        type: "string",
        description: "Custom avatar URL for OAuth actor authorization",
      },
    },
    required: ["title", "teamId"],
  },
};

const updateIssueTool: Tool = {
  name: "linear_update_issue",
  description:
    "Updates an existing Linear issue's properties. Use this to modify issue details like title, description, priority, status, assignment, labels, estimates, due dates, and project/cycle associations. Requires the issue ID and accepts any combination of updatable fields. Returns the updated issue's identifier and URL.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Issue ID" },
      title: { type: "string", description: "New title" },
      description: { type: "string", description: "New description" },
      priority: {
        type: "number",
        description:
          "New priority (0-4, where 0=none, 1=urgent, 2=high, 3=normal, 4=low)",
      },
      status: { type: "string", description: "New status/state ID" },
      assigneeId: {
        type: "string",
        description: "New assignee user ID (use null to unassign)",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "New array of label IDs (replaces existing labels)",
      },
      estimate: { type: "number", description: "New story points estimate" },
      dueDate: {
        type: "string",
        description: "New due date in ISO 8601 format (YYYY-MM-DD)",
      },
      projectId: { type: "string", description: "New project ID" },
      cycleId: { type: "string", description: "New cycle ID" },
    },
    required: ["id"],
  },
};

const searchIssuesTool: Tool = {
  name: "linear_search_issues",
  description:
    "Searches Linear issues using flexible criteria. Supports filtering by any combination of: title/description text, team, status, assignee, labels, priority (1=urgent, 2=high, 3=normal, 4=low), and estimate. Returns up to 10 issues by default (configurable via limit).",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional text to search in title and description",
      },
      teamId: { type: "string", description: "Filter by team ID" },
      status: {
        type: "string",
        description: "Filter by status name (e.g., 'In Progress', 'Done')",
      },
      assigneeId: {
        type: "string",
        description: "Filter by assignee's user ID",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Filter by label names",
      },
      priority: {
        type: "number",
        description: "Filter by priority (1=urgent, 2=high, 3=normal, 4=low)",
      },
      estimate: {
        type: "number",
        description: "Filter by estimate points",
      },
      includeArchived: {
        type: "boolean",
        description: "Include archived issues in results (default: false)",
      },
      limit: {
        type: "number",
        description: "Max results to return (default: 10)",
      },
    },
  },
};

const getUserIssuesTool: Tool = {
  name: "linear_get_user_issues",
  description:
    "Retrieves issues assigned to a user. IMPORTANT: For 'my issues' queries, DO NOT provide userId (gets authenticated user automatically). For other users, first fetch organization data to find their user ID by name, then provide userId parameter. Returns issues sorted by last updated.",
  inputSchema: {
    type: "object",
    properties: {
      userId: {
        type: "string",
        description:
          "User ID - ONLY provide this for other users, NOT for the requesting user's own issues. Omit for 'my issues' queries.",
      },
      includeArchived: {
        type: "boolean",
        description: "Include archived issues in results",
      },
      limit: {
        type: "number",
        description: "Maximum number of issues to return (default: 50)",
      },
    },
  },
};

const addCommentTool: Tool = {
  name: "linear_add_comment",
  description:
    "Adds a comment to an existing Linear issue. Supports markdown formatting in the comment body. Can optionally specify a custom user name and avatar for the comment. Returns the created comment's details including its URL.",
  inputSchema: {
    type: "object",
    properties: {
      issueId: { type: "string", description: "ID of the issue to comment on" },
      body: { type: "string", description: "Comment text in markdown format" },
      createAsUser: {
        type: "string",
        description: "Optional custom username to show for the comment",
      },
      displayIconUrl: {
        type: "string",
        description: "Optional avatar URL for the comment",
      },
    },
    required: ["issueId", "body"],
  },
};

const createAttachmentTool: Tool = {
  name: "linear_create_attachment",
  description:
    "Creates an attachment for a Linear issue. Attachments link external resources to issues with custom titles, subtitles, and metadata. The URL acts as an idempotent key - creating an attachment with the same URL will update the existing one.",
  inputSchema: {
    type: "object",
    properties: {
      issueId: { type: "string", description: "ID of the issue to attach to" },
      title: { type: "string", description: "Attachment title" },
      subtitle: {
        type: "string",
        description: "Attachment subtitle (supports formatting variables)",
      },
      url: {
        type: "string",
        description: "URL of the external resource (must be unique per issue)",
      },
      iconUrl: {
        type: "string",
        description: "Optional icon URL for the attachment",
      },
      metadata: {
        type: "object",
        description: "Optional metadata object for the attachment",
      },
    },
    required: ["issueId", "title", "url"],
  },
};

const updateAttachmentTool: Tool = {
  name: "linear_update_attachment",
  description:
    "Updates an existing Linear attachment's title, subtitle, or metadata. Use this to reflect changes in the external resource status or add additional context.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Attachment ID" },
      title: { type: "string", description: "New attachment title" },
      subtitle: {
        type: "string",
        description: "New attachment subtitle (supports formatting variables)",
      },
      metadata: {
        type: "object",
        description: "New metadata object for the attachment",
      },
    },
    required: ["id"],
  },
};

const getTeamsTool: Tool = {
  name: "linear_get_teams",
  description:
    "Retrieves all teams in the Linear organization. Returns team IDs, names, keys, and descriptions. Essential for finding team IDs needed for creating issues.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const getUsersTool: Tool = {
  name: "linear_get_users",
  description:
    "Retrieves all users in the Linear organization. Returns user IDs, names, display names, emails, and status. Essential for finding user IDs needed for assigning issues.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const getWorkflowStatesTool: Tool = {
  name: "linear_get_workflow_states",
  description:
    "Retrieves all workflow states (issue statuses) available in the organization. Returns state IDs, names, colors, and types. Essential for finding valid status values for creating and updating issues.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const getProjectsTool: Tool = {
  name: "linear_get_projects",
  description:
    "Retrieves all projects in the Linear organization. Returns project IDs, names, descriptions, states, and progress. Essential for finding project IDs needed for associating issues with projects.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const getLabelsTool: Tool = {
  name: "linear_get_labels",
  description:
    "Retrieves all issue labels available in the organization. Returns label IDs, names, colors, and descriptions. Essential for finding label IDs needed for tagging issues.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const getCyclesTool: Tool = {
  name: "linear_get_cycles",
  description:
    "Retrieves all cycles (sprints) in the Linear organization. Returns cycle IDs, names, numbers, and date ranges. Essential for finding cycle IDs needed for sprint planning.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

const resourceTemplates: ResourceTemplate[] = [
  {
    uriTemplate: "linear-issue:///{issueId}",
    name: "Linear Issue",
    description:
      "A Linear issue with its details, comments, and metadata. Use this to fetch detailed information about a specific issue.",
    parameters: {
      issueId: {
        type: "string",
        description:
          "The unique identifier of the Linear issue (e.g., the internal ID)",
      },
    },
    examples: ["linear-issue:///c2b318fb-95d2-4a81-9539-f3268f34af87"],
  },
  {
    uriTemplate: "linear-viewer:",
    name: "Current User",
    description:
      "Information about the authenticated user associated with the API key, including their role, teams, and settings.",
    parameters: {},
    examples: ["linear-viewer:"],
  },
  {
    uriTemplate: "linear-organization:",
    name: "Current Organization",
    description:
      "Details about the Linear organization associated with the API key, including settings, teams, and members.",
    parameters: {},
    examples: ["linear-organization:"],
  },
  {
    uriTemplate: "linear-team:///{teamId}/issues",
    name: "Team Issues",
    description:
      "All active issues belonging to a specific Linear team, including their status, priority, and assignees.",
    parameters: {
      teamId: {
        type: "string",
        description:
          "The unique identifier of the Linear team (found in team settings)",
      },
    },
    examples: ["linear-team:///TEAM-123/issues"],
  },
  {
    uriTemplate: "linear-user:///{userId}/assigned",
    name: "User Assigned Issues",
    description:
      "Active issues assigned to a specific Linear user. Returns issues sorted by update date.",
    parameters: {
      userId: {
        type: "string",
        description:
          "The unique identifier of the Linear user. Use 'me' for the authenticated user",
      },
    },
    examples: [
      "linear-user:///USER-123/assigned",
      "linear-user:///me/assigned",
    ],
  },
];

const serverPrompt: Prompt = {
  name: "linear-server-prompt",
  description: "Instructions for using the Linear MCP server effectively",
  instructions: `This server provides access to Linear, a project management tool. Use it to manage issues, track work, and coordinate with teams.

Key capabilities:
- Create and update issues: Create new tickets or modify existing ones with titles, descriptions, priorities, and team assignments.
- Search functionality: Find issues across the organization using flexible search queries with team and user filters.
- Team coordination: Access team-specific issues and manage work distribution within teams.
- Issue tracking: Add comments and track progress through status updates and assignments.
- Organization overview: View team structures and user assignments across the organization.

User Identification Workflow:
When users ask about issues for themselves or others:
1. Self-queries ("my issues", "issues assigned to me", "what's on my plate"):
   - Use linear_get_user_issues WITHOUT userId parameter: {}
   - This automatically gets the authenticated user's issues
2. Other user queries ("justin's issues", "what is sarah working on"):
   - First fetch linear-organization: resource to get the user list
   - Find the user ID by matching the name provided (e.g., name: "Justin" → id: "user-abc123")
   - Then use linear_get_user_issues WITH the userId parameter: {"userId": "user-abc123"}
3. Always prioritize organization data lookup for accurate user identification

Examples:
- User asks: "What are my issues?" → linear_get_user_issues({})
- User asks: "What is Justin working on?" → First get organization data, find Justin's ID, then linear_get_user_issues({"userId": "found-user-id"})

Tool Usage:
- linear_create_issue:
  - use teamId from linear-organization: resource
  - priority levels: 1=urgent, 2=high, 3=normal, 4=low
  - status must match exact Linear workflow state names (e.g., "In Progress", "Done")

- linear_update_issue:
  - get issue IDs from search_issues or linear-issue:/// resources
  - only include fields you want to change
  - status changes must use valid state IDs from the team's workflow

- linear_search_issues:
  - combine multiple filters for precise results
  - use labels array for multiple tag filtering
  - query searches both title and description
  - returns max 10 results by default

- linear_get_user_issues:
  - omit userId to get authenticated user's issues (recommended for "my issues" queries)
  - when user asks about their own issues, always omit userId parameter
  - when user asks about someone else's issues by name, first fetch organization data to find the user ID
  - useful for workload analysis and sprint planning
  - returns most recently updated issues first

- linear_add_comment:
  - supports full markdown formatting
  - use displayIconUrl for bot/integration avatars
  - createAsUser for custom comment attribution

Best practices:
- When creating issues:
  - Write clear, actionable titles that describe the task well (e.g., "Implement user authentication for mobile app")
  - Include concise but appropriately detailed descriptions in markdown format with context and acceptance criteria
  - Set appropriate priority based on the context (1=critical to 4=nice-to-have)
  - Always specify the correct team ID (default to the user's team if possible)

- When searching:
  - Use specific, targeted queries for better results (e.g., "auth mobile app" rather than just "auth")
  - Apply relevant filters when asked or when you can infer the appropriate filters to narrow results

- When adding comments:
  - Use markdown formatting to improve readability and structure
  - Keep content focused on the specific issue and relevant updates
  - Include action items or next steps when appropriate

- General best practices:
  - Fetch organization data first to get valid team IDs and user information
  - Use search_issues to find issues for bulk operations
  - Include markdown formatting in descriptions and comments
  - For user identification: always check linear-organization: resource first to map names to user IDs
  - When users ask about "my issues" or "issues assigned to me", use linear_get_user_issues without userId parameter

Resource patterns:
- linear-issue:///{issueId} - Single issue details (e.g., linear-issue:///c2b318fb-95d2-4a81-9539-f3268f34af87)
- linear-team:///{teamId}/issues - Team's issue list (e.g., linear-team:///OPS/issues)
- linear-user:///{userId}/assigned - User assignments (e.g., linear-user:///USER-123/assigned)
- linear-organization: - Organization for the current user
- linear-viewer: - Current user context

The server uses the authenticated user's permissions for all operations.`,
};

interface MCPMetricsResponse {
  apiMetrics: {
    requestsInLastHour: number;
    remainingRequests: number;
    averageRequestTime: string;
    queueLength: number;
  };
}

// Zod schemas for tool argument validation
const CreateIssueArgsSchema = z.object({
  title: z.string().describe("Issue title"),
  teamId: z.string().describe("Team ID"),
  description: z.string().optional().describe("Issue description"),
  priority: z.number().min(0).max(4).optional().describe("Priority (0-4)"),
  status: z.string().optional().describe("Issue status"),
  parentId: z
    .string()
    .optional()
    .describe("Parent issue ID (to create a sub-issue)"),
  assigneeId: z.string().optional().describe("User ID to assign this issue to"),
  labels: z
    .array(z.string())
    .optional()
    .describe("Array of label IDs to add to this issue"),
  estimate: z.number().optional().describe("Story points estimate"),
  dueDate: z
    .string()
    .optional()
    .describe("Due date in ISO 8601 format (YYYY-MM-DD)"),
  projectId: z.string().optional().describe("Project ID to add this issue to"),
  cycleId: z.string().optional().describe("Cycle ID to add this issue to"),
  subIssueSortOrder: z
    .number()
    .optional()
    .describe("Position in parent's sub-issue list (for sub-issues)"),
  createAsUser: z
    .string()
    .optional()
    .describe("Custom username for OAuth actor authorization"),
  displayIconUrl: z
    .string()
    .optional()
    .describe("Custom avatar URL for OAuth actor authorization"),
});

const UpdateIssueArgsSchema = z.object({
  id: z.string().describe("Issue ID"),
  title: z.string().optional().describe("New title"),
  description: z.string().optional().describe("New description"),
  priority: z.number().min(0).max(4).optional().describe("New priority (0-4)"),
  status: z.string().optional().describe("New status"),
  assigneeId: z.string().optional().describe("New assignee user ID"),
  labels: z
    .array(z.string())
    .optional()
    .describe("New array of label IDs (replaces existing labels)"),
  estimate: z.number().optional().describe("New story points estimate"),
  dueDate: z
    .string()
    .optional()
    .describe("New due date in ISO 8601 format (YYYY-MM-DD)"),
  projectId: z.string().optional().describe("New project ID"),
  cycleId: z.string().optional().describe("New cycle ID"),
});

const SearchIssuesArgsSchema = z.object({
  query: z
    .string()
    .optional()
    .describe("Optional text to search in title and description"),
  teamId: z.string().optional().describe("Filter by team ID"),
  status: z
    .string()
    .optional()
    .describe("Filter by status name (e.g., 'In Progress', 'Done')"),
  assigneeId: z.string().optional().describe("Filter by assignee's user ID"),
  labels: z.array(z.string()).optional().describe("Filter by label names"),
  priority: z
    .number()
    .optional()
    .describe("Filter by priority (1=urgent, 2=high, 3=normal, 4=low)"),
  estimate: z.number().optional().describe("Filter by estimate points"),
  includeArchived: z
    .boolean()
    .optional()
    .describe("Include archived issues in results (default: false)"),
  limit: z.number().optional().describe("Max results to return (default: 10)"),
});

const GetUserIssuesArgsSchema = z.object({
  userId: z
    .string()
    .optional()
    .describe(
      "Optional user ID. If not provided, returns authenticated user's issues",
    ),
  includeArchived: z
    .boolean()
    .optional()
    .describe("Include archived issues in results"),
  limit: z
    .number()
    .optional()
    .describe("Maximum number of issues to return (default: 50)"),
});

const AddCommentArgsSchema = z.object({
  issueId: z.string().describe("ID of the issue to comment on"),
  body: z.string().describe("Comment text in markdown format"),
  createAsUser: z
    .string()
    .optional()
    .describe("Optional custom username to show for the comment"),
  displayIconUrl: z
    .string()
    .optional()
    .describe("Optional avatar URL for the comment"),
});

const CreateAttachmentArgsSchema = z.object({
  issueId: z.string().describe("ID of the issue to attach to"),
  title: z.string().describe("Attachment title"),
  subtitle: z
    .string()
    .optional()
    .describe("Attachment subtitle (supports formatting variables)"),
  url: z
    .string()
    .describe("URL of the external resource (must be unique per issue)"),
  iconUrl: z
    .string()
    .optional()
    .describe("Optional icon URL for the attachment"),
  metadata: z
    .record(z.any())
    .optional()
    .describe("Optional metadata object for the attachment"),
});

const UpdateAttachmentArgsSchema = z.object({
  id: z.string().describe("Attachment ID"),
  title: z.string().optional().describe("New attachment title"),
  subtitle: z
    .string()
    .optional()
    .describe("New attachment subtitle (supports formatting variables)"),
  metadata: z
    .record(z.any())
    .optional()
    .describe("New metadata object for the attachment"),
});

async function main() {
  try {
    dotenv.config();

    const apiKey = process.env.LINEAR_API_KEY;
    if (!apiKey) {
      console.error("LINEAR_API_KEY environment variable is required");
      process.exit(1);
    }

    console.error("Starting Linear MCP Server...");
    const linearClient = new LinearMCPClient(apiKey);

    const server = new Server(
      {
        name: "linear-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          prompts: {
            default: serverPrompt,
          },
          resources: {
            templates: true,
            read: true,
          },
          tools: {},
        },
      },
    );

    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [],
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async () => {
      throw new Error(
        "Resource reading is disabled to prevent API rate limiting. Use the tools instead.",
      );
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        createIssueTool,
        updateIssueTool,
        searchIssuesTool,
        getUserIssuesTool,
        addCommentTool,
        createAttachmentTool,
        updateAttachmentTool,
        getTeamsTool,
        getUsersTool,
        getWorkflowStatesTool,
        getProjectsTool,
        getLabelsTool,
        getCyclesTool,
      ],
    }));

    server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      return {
        resourceTemplates: resourceTemplates,
      };
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => {
      return {
        prompts: [serverPrompt],
      };
    });

    server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      if (request.params.name === serverPrompt.name) {
        return {
          prompt: serverPrompt,
        };
      }
      throw new Error(`Prompt not found: ${request.params.name}`);
    });

    server.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest) => {
        let metrics: RateLimiterMetrics = {
          totalRequests: 0,
          requestsInLastHour: 0,
          averageRequestTime: 0,
          queueLength: 0,
          lastRequestTime: Date.now(),
        };

        // Add global timeout wrapper for all tool calls
        const toolTimeout = 45000; // 45 second global timeout
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `Tool call timeout after ${toolTimeout}ms for ${request.params.name}`,
              ),
            );
          }, toolTimeout);
        });

        const executeToolCall = async () => {
          const { name, arguments: args } = request.params;
          if (!args) throw new Error("Missing arguments");

          metrics = linearClient.rateLimiter.getMetrics();

          const baseResponse: MCPMetricsResponse = {
            apiMetrics: {
              requestsInLastHour: metrics.requestsInLastHour,
              remainingRequests:
                linearClient.rateLimiter.requestsPerHour -
                metrics.requestsInLastHour,
              averageRequestTime: `${Math.round(metrics.averageRequestTime)}ms`,
              queueLength: 0,
            },
          };

          switch (name) {
            case "linear_create_issue": {
              const validatedArgs = CreateIssueArgsSchema.parse(args);
              const issue = await linearClient.createIssue(validatedArgs);
              return {
                content: [
                  {
                    type: "text",
                    text: `Created issue ${issue.identifier}: ${issue.title}\nURL: ${issue.url}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_update_issue": {
              const validatedArgs = UpdateIssueArgsSchema.parse(args);
              const issue = await linearClient.updateIssue(validatedArgs);
              return {
                content: [
                  {
                    type: "text",
                    text: `Updated issue ${issue.identifier}\nURL: ${issue.url}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_search_issues": {
              const validatedArgs = SearchIssuesArgsSchema.parse(args);
              const response = await linearClient.searchIssues(validatedArgs);

              // Extract the actual issues array - the response should be an array with metadata added
              const issues = Array.isArray(response) ? response : [];

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${issues.length} issues:\n${issues
                      .map(
                        (issue: LinearIssueResponse) =>
                          `- ${issue.identifier}: ${issue.title}\n  Priority: ${issue.priority || "None"}\n  Status: ${issue.status || "None"}\n  ${issue.url}`,
                      )
                      .join("\n")}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_get_user_issues": {
              const validatedArgs = GetUserIssuesArgsSchema.parse(args);
              const response = await linearClient.getUserIssues(validatedArgs);

              // Extract the actual issues array - the response should be an array with metadata added
              const issues = Array.isArray(response) ? response : [];

              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${issues.length} issues:\n${issues
                      .map(
                        (issue: LinearIssueResponse) =>
                          `- ${issue.identifier}: ${issue.title}\n  Priority: ${issue.priority || "None"}\n  Status: ${issue.stateName}\n  ${issue.url}`,
                      )
                      .join("\n")}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_add_comment": {
              const validatedArgs = AddCommentArgsSchema.parse(args);
              const { comment, issue } =
                await linearClient.addComment(validatedArgs);

              return {
                content: [
                  {
                    type: "text",
                    text: `Added comment to issue ${issue?.identifier}\nURL: ${comment.url}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_create_attachment": {
              const validatedArgs = CreateAttachmentArgsSchema.parse(args);
              const attachment =
                await linearClient.createAttachment(validatedArgs);

              return {
                content: [
                  {
                    type: "text",
                    text: `Created attachment "${attachment.title}" for issue\nAttachment ID: ${attachment.id}\nURL: ${validatedArgs.url}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_update_attachment": {
              const validatedArgs = UpdateAttachmentArgsSchema.parse(args);
              const attachment =
                await linearClient.updateAttachment(validatedArgs);

              return {
                content: [
                  {
                    type: "text",
                    text: `Updated attachment "${attachment.title}"\nAttachment ID: ${attachment.id}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_get_teams": {
              const teams = await linearClient.getTeams();
              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${teams.length} teams:\n${teams
                      .map(
                        (team: any) =>
                          `- ${team.name} (${team.key})\n  ID: ${team.id}`,
                      )
                      .join("\n")}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_get_users": {
              const users = await linearClient.getUsers();
              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${users.length} users:\n${users
                      .map(
                        (user: any) =>
                          `- ${user.name} (${user.displayName})\n  ID: ${user.id}\n  Email: ${user.email}`,
                      )
                      .join("\n")}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_get_workflow_states": {
              const states = await linearClient.getWorkflowStates();
              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${states.length} workflow states:\n${states
                      .map(
                        (state: any) =>
                          `- ${state.name} (${state.type})\n  ID: ${state.id}`,
                      )
                      .join("\n")}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_get_projects": {
              const projects = await linearClient.getProjects();
              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${projects.length} projects:\n${projects
                      .map(
                        (project: any) =>
                          `- ${project.name}\n  ID: ${project.id}\n  State: ${project.state}`,
                      )
                      .join("\n")}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_get_labels": {
              const labels = await linearClient.getLabels();
              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${labels.length} labels:\n${labels
                      .map(
                        (label: any) =>
                          `- ${label.name}\n  ID: ${label.id}\n  Color: ${label.color}`,
                      )
                      .join("\n")}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            case "linear_get_cycles": {
              const cycles = await linearClient.getCycles();
              return {
                content: [
                  {
                    type: "text",
                    text: `Found ${cycles.length} cycles:\n${cycles
                      .map(
                        (cycle: any) =>
                          `- ${cycle.name} (#${cycle.number})\n  ID: ${cycle.id}\n  ${cycle.startsAt} - ${cycle.endsAt}`,
                      )
                      .join("\n")}`,
                    metadata: baseResponse,
                  },
                ],
              };
            }

            default:
              throw new Error(`Unknown tool: ${name}`);
          }
        };

        try {
          return await Promise.race([executeToolCall(), timeoutPromise]);
        } catch (error) {
          console.error("Error executing tool:", error);

          const errorResponse: MCPMetricsResponse = {
            apiMetrics: {
              requestsInLastHour: metrics.requestsInLastHour,
              remainingRequests:
                linearClient.rateLimiter.requestsPerHour -
                metrics.requestsInLastHour,
              averageRequestTime: `${Math.round(metrics.averageRequestTime)}ms`,
              queueLength: 0,
            },
          };

          // If it's a Zod error, format it nicely
          if (error instanceof z.ZodError) {
            const formattedErrors = error.errors.map((err) => ({
              path: err.path,
              message: err.message,
              code: "VALIDATION_ERROR",
            }));

            return {
              content: [
                {
                  type: "text",
                  text: `VALIDATION_ERROR: Invalid request parameters\n${formattedErrors.map(err => `- ${err.path.join('.')}: ${err.message}`).join('\n')}`,
                  metadata: {
                    error: true,
                    ...errorResponse,
                  },
                },
              ],
            };
          }

          // For Linear API errors, try to extract useful information
          if (error instanceof Error && "response" in error) {
            return {
              content: [
                {
                  type: "text",
                  text: `API_ERROR: ${error.message}\nStatus: ${(error as any).response?.status || 'unknown'}`,
                  metadata: {
                    error: true,
                    ...errorResponse,
                  },
                },
              ],
            };
          }

          // For all other errors
          return {
            content: [
              {
                type: "text",
                text: `UNKNOWN_ERROR: ${error instanceof Error ? error.message : String(error)}`,
                metadata: {
                  error: true,
                  ...errorResponse,
                },
              },
            ],
          };
        }
      },
    );

    const transport = new StdioServerTransport();
    console.error("Connecting server to transport...");
    await server.connect(transport);
    console.error("Linear MCP Server running on stdio");
  } catch (error) {
    console.error(
      `Fatal error in main(): ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(
    "Fatal error in main():",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
