<?php

/**
 * Clinical Co-Pilot module bootstrap: registers the class loader and subscribes the
 * demographics-dashboard card that embeds/links the co-pilot panel for the chart patient.
 *
 * @package   OpenEMR
 * @link      https://www.open-emr.org
 * @author    Clinical Co-Pilot Project
 * @copyright Copyright (c) 2026 Clinical Co-Pilot Project
 * @license   https://github.com/openemr/openemr/blob/master/LICENSE GNU General Public License 3
 */

use OpenEMR\Core\ModulesClassLoader;
use OpenEMR\Core\OEGlobalsBag;
use OpenEMR\Modules\ClinicalCopilot\Bootstrap;

$classLoader = new ModulesClassLoader(OEGlobalsBag::getInstance()->getProjectDir());
$classLoader->registerNamespaceIfNotExists('OpenEMR\\Modules\\ClinicalCopilot\\', __DIR__ . DIRECTORY_SEPARATOR . 'src');

$bootstrap = new Bootstrap(OEGlobalsBag::getInstance()->getKernel()->getEventDispatcher());
$bootstrap->subscribeToEvents();
