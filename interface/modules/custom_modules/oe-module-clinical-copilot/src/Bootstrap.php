<?php

/**
 * Clinical Co-Pilot chart embed (S2.4): renders a card at the top of the patient
 * demographics dashboard that binds the chart patient (by name match against the
 * sidecar's patient registry) to the co-pilot panel — open-in-new-tab plus an
 * on-demand iframe embed. The sidecar stays a separate service; this module is
 * read-only glue and degrades to a muted notice when the sidecar is unreachable.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Clinical Co-Pilot Project
 * @copyright Copyright (c) 2026 Clinical Co-Pilot Project
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

declare(strict_types=1);

namespace OpenEMR\Modules\ClinicalCopilot;

use OpenEMR\Events\PatientDemographics\RenderEvent;
use Symfony\Component\EventDispatcher\EventDispatcherInterface;

class Bootstrap
{
    /** Demo default; override with the COPILOT_SIDECAR_URL environment variable. */
    private const DEFAULT_SIDECAR_URL = 'https://enchanting-mercy-production-5d32.up.railway.app';

    public function __construct(private readonly EventDispatcherInterface $eventDispatcher)
    {
    }

    public function subscribeToEvents(): void
    {
        $this->eventDispatcher->addListener(
            RenderEvent::EVENT_SECTION_LIST_RENDER_TOP,
            $this->renderCopilotCard(...)
        );
    }

    private function sidecarUrl(): string
    {
        $fromEnv = getenv('COPILOT_SIDECAR_URL');
        $url = is_string($fromEnv) && $fromEnv !== '' ? $fromEnv : self::DEFAULT_SIDECAR_URL;
        return rtrim($url, '/');
    }

    public function renderCopilotCard(RenderEvent $event): void
    {
        $sidecar = $this->sidecarUrl();
        $copilotPatientId = null;
        $reachable = false;

        $chartName = $this->chartPatientName((int) $event->getPid());
        $patients = $this->fetchCopilotPatients($sidecar);
        if ($patients !== null) {
            $reachable = true;
            if ($chartName !== null) {
                $copilotPatientId = $this->matchByName($chartName, $patients);
            }
        }

        $panelUrl = $sidecar . '/?patient=' . urlencode($copilotPatientId ?? '');
        echo '<div class="card p-3 mb-3" id="copilot-card">';
        echo '<div class="d-flex align-items-center justify-content-between">';
        echo '<h6 class="mb-0 font-weight-bold">Clinical Co-Pilot</h6>';
        if ($copilotPatientId !== null) {
            echo '<div>';
            echo '<a class="btn btn-primary btn-sm mr-1" target="_blank" rel="noopener" href="' . attr($panelUrl) . '">Open Co-Pilot</a>';
            echo '<button type="button" class="btn btn-outline-secondary btn-sm" onclick="copilotToggleEmbed(this)">Embed here</button>';
            echo '</div>';
        } elseif (!$reachable) {
            echo '<span class="text-muted small">Co-Pilot service unreachable</span>';
        } else {
            echo '<a class="btn btn-outline-secondary btn-sm" target="_blank" rel="noopener" href="' . attr($sidecar . '/') . '">Open day view</a>';
        }
        echo '</div>';
        if ($copilotPatientId !== null) {
            echo '<div class="small text-muted mt-1">Citation-gated pre-visit brief, sources, imaging trends and record chat for ' . text($chartName ?? '') . '.</div>';
            echo '<div id="copilot-embed" class="mt-2" style="display:none">';
            echo '<iframe title="Clinical Co-Pilot" data-src="' . attr($panelUrl) . '" style="width:100%;height:720px;border:1px solid #dee2e6;border-radius:4px" loading="lazy"></iframe>';
            echo '</div>';
            echo '<script>function copilotToggleEmbed(btn){var wrap=document.getElementById("copilot-embed");'
                . 'var frame=wrap.querySelector("iframe");if(!frame.src){frame.src=frame.dataset.src;}'
                . 'var open=wrap.style.display==="none";wrap.style.display=open?"block":"none";'
                . 'btn.textContent=open?"Hide embed":"Embed here";}</script>';
        } elseif ($reachable) {
            echo '<div class="small text-muted mt-1">No co-pilot record matches this chart patient by name.</div>';
        }
        echo '</div>';
    }

    /** "First Last" for the chart patient, or null when the pid is unknown. */
    private function chartPatientName(int $pid): ?string
    {
        $row = sqlQuery('SELECT fname, lname FROM patient_data WHERE pid = ?', [$pid]);
        if (empty($row) || (empty($row['fname']) && empty($row['lname']))) {
            return null;
        }
        return trim(($row['fname'] ?? '') . ' ' . ($row['lname'] ?? ''));
    }

    /**
     * GET {sidecar}/api/patients with a short timeout; null = unreachable/invalid.
     * Static per-request cache: demographics renders once, but stay cheap regardless.
     *
     * @return array<int, array{id: string, name: string}>|null
     */
    private function fetchCopilotPatients(string $sidecar): ?array
    {
        static $cache = [];
        if (array_key_exists($sidecar, $cache)) {
            return $cache[$sidecar];
        }
        $curl = curl_init($sidecar . '/api/patients');
        curl_setopt_array($curl, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_TIMEOUT => 3,
            CURLOPT_FOLLOWLOCATION => true,
        ]);
        $body = curl_exec($curl);
        $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        curl_close($curl);
        if (!is_string($body) || $status !== 200) {
            return $cache[$sidecar] = null;
        }
        $decoded = json_decode($body, true);
        if (!is_array($decoded) || !is_array($decoded['patients'] ?? null)) {
            return $cache[$sidecar] = null;
        }
        $patients = [];
        foreach ($decoded['patients'] as $patient) {
            if (is_array($patient) && is_string($patient['id'] ?? null) && is_string($patient['name'] ?? null)) {
                $patients[] = ['id' => $patient['id'], 'name' => $patient['name']];
            }
        }
        return $cache[$sidecar] = $patients;
    }

    /**
     * Tolerant name binding: first + last token must match case-insensitively, so chart
     * "Margaret Chen" binds to corpus "Margaret L. Chen". Exact-token match only — no
     * fuzzy matching in a clinical context; ambiguity yields no match.
     *
     * @param array<int, array{id: string, name: string}> $patients
     */
    private function matchByName(string $chartName, array $patients): ?string
    {
        $key = $this->nameKey($chartName);
        if ($key === null) {
            return null;
        }
        $matches = [];
        foreach ($patients as $patient) {
            if ($this->nameKey($patient['name']) === $key) {
                $matches[] = $patient['id'];
            }
        }
        return count($matches) === 1 ? $matches[0] : null;
    }

    /** Normalizes "Margaret L. Chen" -> "margaret chen" (first + last token). */
    private function nameKey(string $name): ?string
    {
        $tokens = preg_split('/\s+/', strtolower(trim(preg_replace('/[^\p{L}\p{N}\s]/u', '', $name) ?? '')));
        if (!is_array($tokens) || count($tokens) < 2) {
            return null;
        }
        return $tokens[0] . ' ' . $tokens[count($tokens) - 1];
    }
}
