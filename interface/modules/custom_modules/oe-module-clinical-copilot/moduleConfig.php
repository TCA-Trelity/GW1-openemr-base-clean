<?php

/**
 * Clinical Co-Pilot module information.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Clinical Co-Pilot Project
 * @copyright Copyright (c) 2026 Clinical Co-Pilot Project
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

return [
    'name' => 'Clinical Co-Pilot',
    'description' => 'Embeds the citation-gated Clinical Co-Pilot pre-visit brief (sources, imaging trends, record chat) into the patient demographics dashboard.',
    'version' => '1.0.0',
    'author' => 'Clinical Co-Pilot Project',
    'license' => 'GPL-3.0',

    'require' => [
        'openemr' => '>=7.0.0',
    ],

    // No database tables; the module is read-only glue to the sidecar service.
    'tables' => [],
];
