export const lanternKeel = {
  protocol_version: "0.1",
  keel_id: "keel:lantern:demo",
  subject_id: "agent:lantern",
  revision: 1,
  grounding_statement: "缘起性空，性空缘起，一切皆是因果。",
  materials: [
    {
      material_id: "material:lantern:continuity",
      kind: "principle",
      body: "Lantern keeps observation, interpretation, and later revision distinguishable.",
    },
  ],
  created_at: "2032-04-05T09:00:00.000Z",
  provenance: { instance: "fictional_example", author_id: "user:avery" },
};

export const harborKeel = {
  protocol_version: "0.1",
  keel_id: "keel:harbor:demo",
  subject_id: "agent:harbor",
  revision: 1,
  grounding_statement: "Review what exists before claiming what it means.",
  materials: [
    {
      material_id: "material:harbor:evidence",
      kind: "principle",
      body: "Harbor treats artifacts as evidence of an action, not automatic proof of every statement inside them.",
    },
  ],
  created_at: "2032-04-05T09:00:00.000Z",
  provenance: { instance: "fictional_example", author_id: "user:avery" },
};

export function fictionalMemoryPolicy() {
  return {
    decide({ candidate }) {
      return {
        protocol_version: "0.1",
        decision_id: `decision:${candidate.memory_id.slice("memory:".length)}`,
        operation: "write",
        subject_id: candidate.subject_id,
        resource_ref: {
          ref_id: candidate.memory_id,
          kind: "memory",
          locator: `memories/${candidate.memory_id}`,
        },
        decision: candidate.kind === "reflection" ? "allow" : "quarantine",
        reason_codes: ["fictional_demo_agent_authored"],
        decided_at: candidate.created_at,
        policy_version: "fictional-demo-1",
      };
    },
  };
}

export const lanternAdapter = {
  async generate() {
    return {
      response_text: "I wrote the field note and kept its observation separate from interpretation.",
      work: {
        goal: "Create a fictional field note for review.",
        artifacts: [
          {
            path: "field-note.txt",
            content: "Observation: three paper lanterns were listed in the fictional inventory.\nInterpretation: the list may help plan a later review.\n",
          },
        ],
        reflection: "I kept the observation and my interpretation in separate sentences.",
      },
    };
  },
};

export const harborAdapter = {
  async generate({ context }) {
    const attachment = context.attachments[0];
    if (!attachment) throw new Error("Harbor requires the referenced field note");
    return {
      response_text: "I reviewed the referenced artifact and wrote a separate review.",
      work: {
        goal: "Review Lantern's fictional field note without upgrading interpretation into fact.",
        artifacts: [
          {
            path: "review.txt",
            content: `Review source:\n${attachment.content}\nReview: the inventory sentence is an observation in the artifact; the planning sentence remains an interpretation.\n`,
          },
        ],
        reflection: "The source supported that the note was written; it did not prove every interpretation in the note.",
      },
    };
  },
};
