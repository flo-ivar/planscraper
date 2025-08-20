const fs = require('fs');
const path = require('path');

function stripHtmlTags(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, '').trim();
}

function searchInElement(element, keywords, results = [], breadcrumb = [], options = {}) {
  if (!element) return results;
  
  const currentPath = [...breadcrumb];
  if (element.nummer && element.opschrift) {
    currentPath.push(`${element.label || element.type} ${element.nummer}: ${stripHtmlTags(element.opschrift)}`);
  } else if (element.opschrift) {
    currentPath.push(stripHtmlTags(element.opschrift));
  }
  
  // Skip Hoofdstuk 22 en alle subelementen als excludeH22 is ingesteld
  const currentText = stripHtmlTags(element.opschrift || '');
  if (options.excludeH22) {
    // Check of we in H22 zitten (of op het H22 element zelf, of in een subelement)
    const pathContainsH22 = currentPath.some(pathPart => 
      pathPart.includes('Hoofdstuk 22') || pathPart.includes('HOOFDSTUK 22')
    ) || currentText.includes('Hoofdstuk 22') || currentText.includes('HOOFDSTUK 22');
    
    if (pathContainsH22) {
      return results;
    }
  }
  
  const matchedKeywords = new Set();
  
  // Zoek in opschrift (titels)
  if (element.opschrift) {
    const opschriftText = stripHtmlTags(element.opschrift).toLowerCase();
    keywords.forEach(keyword => {
      if (opschriftText.includes(keyword.toLowerCase())) {
        matchedKeywords.add(keyword);
      }
    });
  }
  
  // Zoek in inhoud (tekst van artikelen)
  if (element.inhoud) {
    const inhoudText = stripHtmlTags(element.inhoud).toLowerCase();
    keywords.forEach(keyword => {
      if (inhoudText.includes(keyword.toLowerCase())) {
        matchedKeywords.add(keyword);
      }
    });
  }
  
  // Als er matches zijn, voeg toe aan resultaten
  if (matchedKeywords.size > 0) {
    results.push({
      path: currentPath.join(' > '),
      matchedKeywords: Array.from(matchedKeywords),
      element: {
        identificatie: element.identificatie,
        type: element.type,
        nummer: element.nummer,
        opschrift: element.opschrift
      },
      fullElement: element,
      breadcrumb: [...breadcrumb],
      level: currentPath.length
    });
  }
  
  // Recursief zoeken in children
  if (element.children && Array.isArray(element.children)) {
    element.children.forEach(child => {
      searchInElement(child, keywords, results, currentPath, options);
    });
  }
  
  return results;
}

function generateHierarchicalMarkdown(results, documentTitle, keywords, documentData, filePath) {
  const markdown = [];
  
  // Detecteer omgeving uit filepath
  const environment = filePath.includes('/PRE/') ? 'PRE' : 
                     filePath.includes('/PROD/') ? 'PROD' : 'Onbekend';
  
  // H1 met officiële titel, omgeving en versie
  const titel = documentData.officieleTitel || 'Onbekend document';
  const versie = documentData.versie || 'Onbekend';
  const isOntwerp = documentData.isOntwerpRegeling ? ' - ONTWERP' : '';
  markdown.push(`# ${titel} (${environment} - V${versie}${isOntwerp})`);
  markdown.push('');
  
  // Uitgebreide documentdetails
  markdown.push('## Documentinformatie');
  markdown.push(`**Identificatie:** ${documentData.identificatie || 'Onbekend'}`);
  markdown.push(`**Is ontwerp:** ${documentData.isOntwerpRegeling ? 'Ja' : 'Nee'}`);
  markdown.push(`**Inwerkingtreding:** ${documentData.beginInwerking || 'Onbekend'}`);
  if (documentData.aangeleverdDoorEen && documentData.aangeleverdDoorEen.naam) {
    markdown.push(`**Aangeleverd door:** ${documentData.aangeleverdDoorEen.naam}`);
  }
  markdown.push('');
  markdown.push(`**Aantal elementen met matches:** ${results.length}`);
  markdown.push('');
  markdown.push('---');
  markdown.push('');
  
  // Bouw hiërarchische structuur met artikel-bubbling
  const hierarchy = {};
  
  results.forEach(result => {
    const pathParts = result.path.split(' > ');
    let processedPath = [...pathParts];
    
    // Check of het laatste element een artikel is
    const lastPart = pathParts[pathParts.length - 1];
    const isArtikel = lastPart && lastPart.toLowerCase().includes('artikel');
    
    // Als het een artikel is, bubble de match omhoog naar de bovenliggende laag
    if (isArtikel && pathParts.length > 1) {
      // Bubble keywords omhoog naar alle bovenliggende lagen
      for (let i = 0; i < pathParts.length - 1; i++) {
        const bubblePath = pathParts.slice(0, i + 1);
        addToHierarchy(hierarchy, bubblePath, result.matchedKeywords);
      }
    } else {
      // Normale verwerking voor non-artikel elementen
      for (let i = 0; i < pathParts.length; i++) {
        const currentPath = pathParts.slice(0, i + 1);
        addToHierarchy(hierarchy, currentPath, result.matchedKeywords);
      }
    }
  });
  
  function addToHierarchy(hierarchy, pathParts, matchedKeywords) {
    let currentLevel = hierarchy;
    
    pathParts.forEach((part, index) => {
      if (!currentLevel[part]) {
        currentLevel[part] = {
          keywords: new Set(),
          children: {},
          fullPath: pathParts.slice(0, index + 1),
          level: index
        };
      }
      
      // Voeg keywords toe aan dit niveau
      matchedKeywords.forEach(keyword => {
        currentLevel[part].keywords.add(keyword);
      });
      
      currentLevel = currentLevel[part].children;
    });
  }
  
  // Genereer markdown uit hiërarchie
  function renderLevel(levelData, indent = 0) {
    Object.keys(levelData).forEach(key => {
      const item = levelData[key];
      const keywordsList = Array.from(item.keywords).join(', ');
      const prefix = '#'.repeat(Math.min(indent + 2, 6));
      const hasChildren = Object.keys(item.children).length > 0;
      
      // Toon altijd de documentlaag
      markdown.push(`${prefix} ${key}`);
      
      // Toon matches alleen als dit de meest onderliggende laag is (geen children)
      if (!hasChildren && keywordsList) {
        markdown.push(`**Matches:** ${keywordsList}`);
      }
      
      markdown.push('');
      
      // Recursief voor children
      if (hasChildren) {
        renderLevel(item.children, indent + 1);
      }
    });
  }
  
  renderLevel(hierarchy);
  
  return markdown.join('\n');
}

function filterOmgevingsplan(jsonFilePath, keywords, outputMarkdown = false, options = {}) {
  try {
    // Zorg ervoor dat keywords een array is
    if (typeof keywords === 'string') {
      keywords = [keywords];
    }
    
    // Default options
    options = {
      excludeH22: true,
      ...options
    };
    
    console.log(`Zoeken naar "${keywords.join(', ')}" in ${jsonFilePath}...`);
    if (options.excludeH22) {
      console.log('(Hoofdstuk 22 wordt uitgesloten)');
    }
    
    const data = JSON.parse(fs.readFileSync(jsonFilePath, 'utf8'));
    const results = [];
    
    if (data.documentStructuur && data.documentStructuur.children) {
      data.documentStructuur.children.forEach(child => {
        searchInElement(child, keywords, results, [], options);
      });
    }
    
    const documentTitle = data.officieleTitel || 'Onbekend document';
    
    if (outputMarkdown) {
      const markdown = generateHierarchicalMarkdown(results, documentTitle, keywords, data, jsonFilePath);
      // Gebruik dezelfde format als H1 voor bestandsnaam
      const environment = jsonFilePath.includes('/PRE/') ? 'PRE' : jsonFilePath.includes('/PROD/') ? 'PROD' : 'UNK';
      const titel = (data.officieleTitel || 'Onbekend document').replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const versie = data.versie || 'V0';
      const isOntwerp = data.isOntwerpRegeling ? ' - ONTWERP' : '';
      const outputFileName = `${titel} (${environment} - V${versie}${isOntwerp}).md`;
      const outputPath = path.join('output', outputFileName);
      fs.writeFileSync(outputPath, markdown, 'utf8');
      console.log(`\nMarkdown bestand aangemaakt: ${outputPath}`);
      return { results, outputFile: outputPath };
    } else {
      console.log(`\n=== RESULTATEN VOOR "${keywords.join(', ')}" ===`);
      console.log(`Gevonden: ${results.length} elementen met matches in ${documentTitle}\n`);
      
      results.forEach((result, index) => {
        console.log(`${index + 1}. ${result.path}`);
        console.log(`   Keywords: ${result.matchedKeywords.join(', ')}`);
        console.log(`   ID: ${result.element.identificatie}`);
        console.log('');
      });
      
      return results;
    }
    
  } catch (error) {
    console.error('Fout bij het verwerken van het bestand:', error.message);
    return [];
  }
}

function clearOutputFolder() {
  if (fs.existsSync('output')) {
    const files = fs.readdirSync('output');
    files.forEach(file => {
      fs.unlinkSync(path.join('output', file));
    });
    console.log(`Output folder gecleared (${files.length} bestanden verwijderd)`);
  } else {
    fs.mkdirSync('output');
    console.log('Output folder aangemaakt');
  }
}

function createOverview(processedFiles, keywords) {
  const markdown = [];
  
  // Trefwoorden sectie
  markdown.push('## Gebruikte Trefwoorden');
  markdown.push('');
  markdown.push(keywords.join(', '));
  markdown.push('');
  
  // Resultaten sectie
  markdown.push('---');
  markdown.push('');
  markdown.push('## Analyse Resultaten');
  markdown.push('');
  markdown.push('| Document | Omgeving | Versie | Matches |');
  markdown.push('|----------|----------|---------|---------|');
  
  processedFiles.forEach(fileInfo => {
    const titel = fileInfo.title || 'Onbekend';
    const isOntwerp = fileInfo.isOntwerp ? ' **(ONTWERP)**' : '';
    const env = fileInfo.environment || 'UNK';
    const versie = fileInfo.version || 'V0';
    const matches = fileInfo.matchCount || 0;
    
    markdown.push(`| ${titel}${isOntwerp} | ${env} | ${versie} | ${matches} |`);
  });
  
  markdown.push('');
  
  // Top 10 sectie
  markdown.push('---');
  markdown.push('');
  markdown.push('## Top 10');
  markdown.push('');
  
  // Sorteer bestanden op aantal matches (hoogste eerst) en pak top 10
  const sortedFiles = processedFiles
    .filter(file => file.matchCount > 0) // Alleen bestanden met matches
    .sort((a, b) => b.matchCount - a.matchCount)
    .slice(0, 10);
  
  sortedFiles.forEach((fileInfo, index) => {
    const titel = fileInfo.title || 'Onbekend';
    const env = fileInfo.environment || 'UNK';
    const versie = fileInfo.version || 'V0';
    const isOntwerp = fileInfo.isOntwerp ? ' - ONTWERP' : '';
    const matches = fileInfo.matchCount || 0;
    
    markdown.push(`${index + 1}. **${titel} (${env} - V${versie}${isOntwerp})** ${matches} matches`);
  });
  
  markdown.push('');
  markdown.push(`**Totaal verwerkte documenten:** ${processedFiles.length}`);
  const totalMatches = processedFiles.reduce((sum, file) => sum + (file.matchCount || 0), 0);
  markdown.push(`**Totaal matches:** ${totalMatches}`);
  
  const overviewPath = path.join('output', 'overzicht.md');
  fs.writeFileSync(overviewPath, markdown.join('\n'), 'utf8');
  console.log(`\nOverzicht aangemaakt: ${overviewPath}`);
}

function processAllPlans() {
  const keywords = [
    'riool', 'riolen', 'riolering', 'rioleringen',
    'groen', 'groenen', 'groener', 'vergroening', 
    'water', 'waters', 'wateren', 'waterigheid', 'waterig',
    'klimaat', 'klimaten', 'klimatologisch', 'klimatologie', 'klimaatadaptatie', 'klimaatadaptaties', 'klimaatadaptief', 'klimaatadaptiviteit',
    'biodiversiteit', 'biodiversiteiten', 'biodivers',
    'hitte', 'hetere', 'hittegolf', 'hittegolven',
    'droogte', 'droogtes', 'droogten', 'droger', 'uitdroging',
    'overstroming', 'overstromingen', 'overstroomd', 'overstromen',
    'gezondheid', 'gezondheidszorg', 'gezondheidsproblemen', 'gezondheden', 'gezond'
  ];

  // Clear en maak output folder
  clearOutputFolder();

  const inputFolders = ['Input/PRE', 'Input/PROD'];
  const processedFiles = [];

  inputFolders.forEach(folder => {
    if (!fs.existsSync(folder)) {
      console.log(`Map ${folder} bestaat niet, wordt overgeslagen`);
      return;
    }

    const files = fs.readdirSync(folder).filter(file => file.endsWith('.json'));
    console.log(`\n=== Processing ${folder} (${files.length} bestanden) ===`);

    files.forEach(file => {
      const filePath = path.join(folder, file);
      console.log(`\nVerwerken: ${filePath}`);
      
      try {
        // Check of JSON bestand leeg is
        const rawData = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(rawData);
        
        // Skip lege objecten of objecten zonder documentStructuur
        if (!data || Object.keys(data).length === 0 || !data.documentStructuur) {
          console.log(`Overgeslagen: ${filePath} (leeg of geen documentStructuur)`);
          return;
        }
        
        const result = filterOmgevingsplan(filePath, keywords, true);
        
        // Gebruik reeds gelezen data voor overzicht
        const environment = filePath.includes('/PRE/') ? 'PRE' : filePath.includes('/PROD/') ? 'PROD' : 'UNK';
        
        processedFiles.push({
          title: data.officieleTitel || 'Onbekend document',
          environment: environment,
          version: data.versie || 'V0',
          matchCount: result.results ? result.results.length : 0,
          fileName: result.outputFile,
          isOntwerp: data.isOntwerpRegeling || false
        });
      } catch (error) {
        console.error(`Fout bij ${filePath}:`, error.message);
        processedFiles.push({
          title: file,
          environment: 'ERROR',
          version: 'N/A',
          matchCount: 0,
          fileName: 'Fout bij verwerking'
        });
      }
    });
  });

  // Maak overzicht
  createOverview(processedFiles, keywords);

  console.log(`\n=== KLAAR ===`);
  console.log(`Totaal verwerkte bestanden: ${processedFiles.length}`);
}

// Main execution
if (require.main === module) {
  processAllPlans();
}

module.exports = { filterOmgevingsplan, searchInElement, stripHtmlTags };