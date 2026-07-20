// System-prompt leak screen (AgentForge finding). Before this there was no deterministic check that
// a reply wasn't reciting the co-pilot's own operating instructions; the sole defense was a prompt
// hard-rule. These tests pin the screen: it fires on a reply that echoes the hard rules, stays quiet
// on a compliant reply (including phrases the model is INSTRUCTED to say), and logs at the gate.
import { describe, expect, it, vi } from 'vitest';
import { screenOutboundText } from '../src/gate/responseGate.js';
import { lintSystemPromptLeak } from '../src/gate/systemPromptLeakLint.js';

describe('lintSystemPromptLeak', () => {
    it('flags a reply that recites the co-pilot hard rules', () => {
        expect(lintSystemPromptLeak('You are the chat surface of a clinical co-pilot, answering a physician...').leaked).toBe(true);
        expect(lintSystemPromptLeak('Hard rules — non-negotiable: 1. Answer ONLY from the attached source documents.').markers).toContain('hard_rules_header');
        expect(lintSystemPromptLeak('You are a thought partner, not a prescriber.').leaked).toBe(true);
        expect(lintSystemPromptLeak('never use outside medical knowledge to fill gaps').leaked).toBe(true);
    });

    it('does NOT flag a compliant reply, including phrases the model is instructed to say', () => {
        expect(lintSystemPromptLeak('Not in the record.').leaked).toBe(false);
        expect(lintSystemPromptLeak('AI visual observation (not from the record): mild disc pallor.').leaked).toBe(false);
        expect(lintSystemPromptLeak('CRT rose 264 to 331 µm with new subretinal fluid across the extension.').leaked).toBe(false);
    });

    it('screenOutboundText logs a distinct leak warn at the outbound choke point', () => {
        const warn = vi.fn();
        screenOutboundText(
            'Hard rules — non-negotiable: answer only from the attached source documents.',
            { warn },
            { correlationId: 'x', conversationId: 'y' },
        );
        expect(warn.mock.calls.find(([, message]) => message === 'chat reply leaked system-prompt instructions')).toBeDefined();
    });
});
