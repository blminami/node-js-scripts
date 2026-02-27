import { graphql } from "@octokit/graphql";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_LOGIN = process.env.GITHUB_LOGIN || "blminami";
const ORG = process.env.GITHUB_ORG || "gorgias";

if (!GITHUB_TOKEN) {
  console.error("Error: GITHUB_TOKEN environment variable is required.");
  console.error("Usage: GITHUB_TOKEN=ghp_xxx npx ts-node script-pr-size-analytics.ts");
  process.exit(1);
}

const graphqlWithAuth = graphql.defaults({
  headers: { authorization: `token ${GITHUB_TOKEN}` },
});

interface PR {
  number: number;
  title: string;
  url: string;
  additions: number;
  deletions: number;
  mergedAt: string | null;
  repository: { name: string };
}

async function fetchAllPRs(): Promise<PR[]> {
  const allPRs: PR[] = [];
  let cursor: string | null = null;
  let page = 1;

  console.log(`Fetching PRs authored by ${GITHUB_LOGIN} in org ${ORG}...`);

  while (true) {
    const query = `
      query($login: String!, $org: String!, $cursor: String) {
        user(login: $login) {
          pullRequests(
            first: 100
            after: $cursor
            orderBy: { field: CREATED_AT, direction: DESC }
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              title
              url
              additions
              deletions
              mergedAt
              repository {
                name
                owner { login }
              }
            }
          }
        }
      }
    `;

    const result: any = await graphqlWithAuth(query, {
      login: GITHUB_LOGIN,
      org: ORG,
      cursor,
    });

    const prs = result.user.pullRequests.nodes as any[];
    const pageInfo = result.user.pullRequests.pageInfo;

    // Filter to only PRs in the target org
    const orgPRs = prs
      .filter((pr: any) => pr.repository.owner.login === ORG)
      .map((pr: any) => ({
        number: pr.number,
        title: pr.title,
        url: pr.url,
        additions: pr.additions,
        deletions: pr.deletions,
        mergedAt: pr.mergedAt,
        repository: { name: pr.repository.name },
      }));

    allPRs.push(...orgPRs);
    process.stdout.write(`\r  Page ${page}: fetched ${allPRs.length} PRs in ${ORG} so far...`);
    page++;

    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  console.log(`\n  Done. Total PRs in ${ORG}: ${allPRs.length}`);
  return allPRs;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function main() {
  const prs = await fetchAllPRs();

  if (prs.length === 0) {
    console.log(`\nNo PRs found for ${GITHUB_LOGIN} in org ${ORG}.`);
    return;
  }

  const sizes = prs.map((pr) => pr.additions + pr.deletions);
  const additions = prs.map((pr) => pr.additions);
  const deletions = prs.map((pr) => pr.deletions);

  const mergedPRs = prs.filter((pr) => pr.mergedAt !== null);
  const mergedSizes = mergedPRs.map((pr) => pr.additions + pr.deletions);

  // Per-repo breakdown
  const byRepo: Record<string, number[]> = {};
  for (const pr of prs) {
    const repo = pr.repository.name;
    if (!byRepo[repo]) byRepo[repo] = [];
    byRepo[repo].push(pr.additions + pr.deletions);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`PR SIZE ANALYTICS — ${GITHUB_LOGIN} @ ${ORG}`);
  console.log("=".repeat(60));

  console.log(`\nAll PRs (${prs.length} total):`);
  console.log(`  Average size (lines changed): ${Math.round(average(sizes))}`);
  console.log(`  Median size  (lines changed): ${Math.round(median(sizes))}`);
  console.log(`  P75:  ${Math.round(percentile(sizes, 75))} lines`);
  console.log(`  P90:  ${Math.round(percentile(sizes, 90))} lines`);
  console.log(`  P99:  ${Math.round(percentile(sizes, 99))} lines`);
  console.log(`  Min:  ${Math.min(...sizes)} lines`);
  console.log(`  Max:  ${Math.max(...sizes)} lines`);

  if (mergedPRs.length > 0) {
    console.log(`\nMerged PRs only (${mergedPRs.length} total):`);
    console.log(`  Average size: ${Math.round(average(mergedSizes))}`);
    console.log(`  Median size:  ${Math.round(median(mergedSizes))}`);
  }

  console.log(`\nBreakdown (avg additions / avg deletions across all PRs):`);
  console.log(`  Avg additions: +${Math.round(average(additions))}`);
  console.log(`  Avg deletions: -${Math.round(average(deletions))}`);

  console.log(`\nPer-repository breakdown (avg lines changed):`);
  const repoStats = Object.entries(byRepo)
    .map(([repo, s]) => ({ repo, count: s.length, avg: Math.round(average(s)), median: Math.round(median(s)) }))
    .sort((a, b) => b.count - a.count);
  for (const { repo, count, avg, median: med } of repoStats) {
    console.log(`  ${repo.padEnd(40)} ${String(count).padStart(4)} PRs  avg: ${String(avg).padStart(6)} lines  median: ${med}`);
  }

  // Largest PRs
  const top5 = [...prs]
    .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
    .slice(0, 5);
  console.log("\nTop 5 largest PRs:");
  for (const pr of top5) {
    const size = pr.additions + pr.deletions;
    console.log(`  [${pr.repository.name}] #${pr.number} — ${pr.title.slice(0, 50)}`);
    console.log(`    ${size} lines (+${pr.additions}/-${pr.deletions}) — ${pr.url}`);
  }

  console.log("\n" + "=".repeat(60));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
