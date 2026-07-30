/**
 * project/saveProject.js — serialise the current map state to a downloadable
 * .json project file.
 */







      function wireSaveProject() {
      $('saveBtn').addEventListener('click', () => {
        // The project shape lives in project/projectState.js so that the file, the
        // autosave and the project library cannot disagree about what a project is.
        const proj = serialiseProject();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(proj)], { type: 'application/json' }));
        a.download = 'property-map-project.json';
        a.click();
        URL.revokeObjectURL(a.href);
        status('Project saved — open it later with "Open project".');
      });
      }
