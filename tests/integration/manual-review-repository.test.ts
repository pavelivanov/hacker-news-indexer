import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { describe, expect, it } from "vitest";

describe("manual review forward migration", () => {
  it("preserves legacy model/manual decisions and rejects unowned initial manual decisions", async () => {
    const connectionString = process.env["DATABASE_URL"];
    if (
      !connectionString ||
      new URL(connectionString).pathname !== "/hn_manual_review_test" ||
      !["127.0.0.1", "localhost", "[::1]"].includes(
        new URL(connectionString).hostname,
      )
    ) {
      throw new Error(
        "Migration test requires the isolated local test database",
      );
    }
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      await client.query("DROP SCHEMA IF EXISTS manual_review_upgrade CASCADE");
      await client.query("CREATE SCHEMA manual_review_upgrade");
      await client.query("SET search_path TO manual_review_upgrade");
      const directory = new URL(
        "../../packages/db/prisma/migrations/",
        import.meta.url,
      );
      const migrations = (await readdir(directory))
        .filter((name) => /^\d/.test(name))
        .sort();
      for (const name of migrations.filter(
        (name) => name < "0008_manual_review",
      )) {
        await client.query(
          await readFile(new URL(`${name}/migration.sql`, directory), "utf8"),
        );
      }
      await client.query(`INSERT INTO hn_items(id,type,availability,fetched_at,response_hash)
        VALUES(1,'comment','AVAILABLE',now(),'fixture');
        INSERT INTO selected_comments(id,root_id,canonical_html,canonical_text,content_hash,availability,last_seen_at)
        VALUES(1,1,'','', 'fixture','AVAILABLE',now());
        INSERT INTO classification_runs(id,comment_id,input_hash,prompt_version,prompt_hash,schema_version,model_config_id,provider,model_id,output_hash,status)
        VALUES('00000000-0000-4000-8000-000000000001',1,'fixture','fixture','fixture','classification.v1','fixture','fixture','fixture','fixture','REVIEW');
        INSERT INTO content_decisions(id,comment_id,classification_run_id,source,primary_decision,decision_confidence,materially_technical,review_required,validated_output)
        VALUES('00000000-0000-4000-8000-000000000002',1,'00000000-0000-4000-8000-000000000001','MODEL','REVIEW',0.5,false,true,'{}');
        INSERT INTO content_decisions(id,comment_id,source,primary_decision,decision_confidence,materially_technical,review_required,validated_output,manual_override_of_id)
        VALUES('00000000-0000-4000-8000-000000000003',1,'MANUAL','REJECTED',0.5,false,true,'{}','00000000-0000-4000-8000-000000000002');`);
      const select =
        "SELECT id, source, classification_run_id, manual_override_of_id, validated_output FROM content_decisions ORDER BY id";
      const before = await client.query(select);
      await client.query(
        await readFile(
          new URL("0008_manual_review/migration.sql", directory),
          "utf8",
        ),
      );
      expect((await client.query(select)).rows).toEqual(before.rows);
      expect(before.rows).toHaveLength(2);
      await expect(
        client.query(`INSERT INTO content_decisions(comment_id,source,primary_decision,decision_confidence,materially_technical,review_required,validated_output)
        VALUES(1,'MANUAL','REJECTED',0.5,false,true,'{}')`),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await client.query("SET search_path TO public");
      await client.query("DROP SCHEMA IF EXISTS manual_review_upgrade CASCADE");
      await client.end();
    }
  });
});
