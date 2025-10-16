import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as Plotly from "plotly.js-dist";

const SeismicViewer = () => {
  const [files, setFiles] = useState([]);
  const [cubeInfo, setCubeInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [sliceVisibility, setSliceVisibility] = useState({
    inline: true,
    xline: true,
    sample: true
  });
  const [sliceIndices, setSliceIndices] = useState({
    inline: 0,
    xline: 0,
    sample: 0
  });
  const [sliceData, setSliceData] = useState({});
  const [cubeId, setCubeId] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [mongoConnected, setMongoConnected] = useState(false);
  const [vizError, setVizError] = useState(null);
  const [colorScheme, setColorScheme] = useState('seismic');
  const [customColors, setCustomColors] = useState(['#000080', '#0066CC', '#00AAFF', '#FFFFFF', '#FFAA00', '#FF6600', '#CC0000']);
  const [showColorCustomizer, setShowColorCustomizer] = useState(false);
  const plotDiv = useRef(null);

  const API_BASE_URL = 'http://localhost:5000/api';

  const colorSchemes = {
    seismic: [
      [0.0, '#000080'],
      [0.15, '#0066CC'],
      [0.3, '#00AAFF'],
      [0.4, '#66DDFF'],
      [0.45, '#CCFFFF'],
      [0.5, '#FFFFFF'],
      [0.55, '#FFFFCC'],
      [0.6, '#FFDD66'],
      [0.7, '#FFAA00'],
      [0.85, '#FF6600'],
      [1.0, '#CC0000']
    ],
    viridis: [
      [0.0, '#440154'],
      [0.1, '#482878'],
      [0.2, '#3e4a89'],
      [0.3, '#31688e'],
      [0.4, '#26828e'],
      [0.5, '#1f9e89'],
      [0.6, '#35b779'],
      [0.7, '#6ece58'],
      [0.8, '#b5de2b'],
      [0.9, '#e6e419'],
      [1.0, '#fde724']
    ],
    hot: [
      [0.0, '#000000'],
      [0.2, '#FF0000'],
      [0.4, '#FF7F00'],
      [0.6, '#FFFF00'],
      [0.8, '#FFFFFF'],
      [1.0, '#FFFFFF']
    ],
    cool: [
      [0.0, '#00008B'],
      [0.25, '#0099FF'],
      [0.5, '#00FFFF'],
      [0.75, '#00FF99'],
      [1.0, '#00FF00']
    ],
    grayscale: [
      [0.0, '#000000'],
      [0.5, '#808080'],
      [1.0, '#FFFFFF']
    ],
    jet: [
      [0.0, '#0000FF'],
      [0.25, '#00FFFF'],
      [0.5, '#00FF00'],
      [0.75, '#FFFF00'],
      [1.0, '#FF0000']
    ]
  };

  const getCurrentColorscale = useCallback(() => {
    if (colorScheme === 'custom') {
      const n = customColors.length;
      return customColors.map((color, i) => [i / (n - 1), color]);
    }
    return colorSchemes[colorScheme] || colorSchemes.seismic;
  }, [colorScheme, customColors]);

  useEffect(() => {
    checkHealth();
  }, []);

  const checkHealth = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/health`);
      const data = await response.json();
      setMongoConnected(data.mongodb_status === 'connected');
      console.log('Health check:', data);
    } catch (err) {
      console.error('Health check failed:', err);
    }
  };

  const getAmplitudeRange = () => {
    if (!cubeInfo || !cubeInfo.amplitude_range) return { min: 0, max: 1 };
    const ampRange = cubeInfo.amplitude_range;
    const minVal = ampRange.display_min !== undefined ? ampRange.display_min :
      ampRange.actual_min !== undefined ? ampRange.actual_min : ampRange.min || 0;
    const maxVal = ampRange.display_max !== undefined ? ampRange.display_max :
      ampRange.actual_max !== undefined ? ampRange.actual_max : ampRange.max || 1;
    return { min: minVal, max: maxVal };
  };

  const handleFileUpload = async (event) => {
    const selectedFiles = Array.from(event.target.files);
    setFiles(selectedFiles);
    setError(null);
    setVizError(null);
    setLoading(true);
    const formData = new FormData();
    selectedFiles.forEach(file => {
      formData.append('files', file);
    });
    try {
      console.log('Uploading files...');
      const response = await fetch(`${API_BASE_URL}/upload`, {
        method: 'POST',
        body: formData,
      });
      const result = await response.json();
      console.log('Upload response:', result);
      if (!response.ok) {
        throw new Error(result.error || 'Upload failed');
      }
      setCubeInfo(result.cube_info);
      setCubeId(result.cube_id);
      setSessionId(result.session_id);
      setMongoConnected(result.mongodb_connected);
      const middleIndices = {
        inline: Math.floor(result.cube_info.shape[0] / 2),
        xline: Math.floor(result.cube_info.shape[1] / 2),
        sample: Math.floor(result.cube_info.shape[2] / 2)
      };
      setSliceIndices(middleIndices);
      console.log('Loading slice data...');
      await loadSliceData(middleIndices);
    } catch (err) {
      console.error('Upload error:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadSliceData = async (indices) => {
    const newSliceData = {};
    try {
      for (const sliceType of ['inline', 'xline', 'sample']) {
        console.log(`Loading ${sliceType} slice at index ${indices[sliceType]}`);
        const response = await fetch(`${API_BASE_URL}/slice/${sliceType}/${indices[sliceType]}`);
        if (response.ok) {
          const data = await response.json();
          newSliceData[sliceType] = data;
          console.log(`${sliceType} slice loaded, data shape:`, data.data?.length);
        } else {
          console.error(`Failed to load ${sliceType} slice`);
        }
      }
      setSliceData(newSliceData);
      console.log('All slices loaded:', Object.keys(newSliceData));
    } catch (err) {
      console.error('Failed to load slice data:', err);
      setVizError('Failed to load slice data: ' + err.message);
    }
  };

  const handleSliceChange = async (sliceType, index) => {
    const newIndices = { ...sliceIndices, [sliceType]: index };
    setSliceIndices(newIndices);
    await loadSliceData(newIndices);
  };

  const handleVisibilityChange = (sliceType) => {
    setSliceVisibility(prev => ({
      ...prev,
      [sliceType]: !prev[sliceType]
    }));
  };

  const handleColorChange = (index, color) => {
    const newColors = [...customColors];
    newColors[index] = color;
    setCustomColors(newColors);
  };

  const addColorToCustom = () => {
    setCustomColors([...customColors, '#808080']);
  };

  const removeColorFromCustom = (index) => {
    if (customColors.length > 2) {
      setCustomColors(customColors.filter((_, i) => i !== index));
    }
  };

  const createCubeOutline = useCallback(() => {
    if (!cubeInfo) return [];
    const { inline_range, xline_range, sample_range } = cubeInfo;
    const vertices = [
      [inline_range.min, xline_range.min, sample_range.min],
      [inline_range.max, xline_range.min, sample_range.min],
      [inline_range.max, xline_range.max, sample_range.min],
      [inline_range.min, xline_range.max, sample_range.min],
      [inline_range.min, xline_range.min, sample_range.max],
      [inline_range.max, xline_range.min, sample_range.max],
      [inline_range.max, xline_range.max, sample_range.max],
      [inline_range.min, xline_range.max, sample_range.max]
    ];
    const edges = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7]
    ];
    return edges.map((edge) => {
      const start = vertices[edge[0]];
      const end = vertices[edge[1]];
      return {
        type: 'scatter3d',
        x: [start[0], end[0]],
        y: [start[1], end[1]],
        z: [start[2], end[2]],
        mode: 'lines',
        line: { color: 'rgba(100,100,100,0.8)', width: 4 },
        showlegend: false,
        hoverinfo: 'skip'
      };
    });
  }, [cubeInfo]);

  const createCoordinateAxes = useCallback(() => {
    if (!cubeInfo) return [];
    const { inline_range, xline_range, sample_range } = cubeInfo;
    const originX = inline_range.min;
    const originY = xline_range.min;
    const originZ = sample_range.min;
    const xLength = (inline_range.max - inline_range.min) * 0.15;
    const yLength = (xline_range.max - xline_range.min) * 0.15;
    const zLength = (sample_range.max - sample_range.min) * 0.15;
    return [
      {
        type: 'scatter3d',
        x: [originX, originX + xLength],
        y: [originY, originY],
        z: [originZ, originZ],
        mode: 'lines',
        line: { color: 'red', width: 6 },
        showlegend: false,
        hoverinfo: 'skip'
      },
      {
        type: 'scatter3d',
        x: [originX, originX],
        y: [originY, originY + yLength],
        z: [originZ, originZ],
        mode: 'lines',
        line: { color: 'green', width: 6 },
        showlegend: false,
        hoverinfo: 'skip'
      },
      {
        type: 'scatter3d',
        x: [originX, originX],
        y: [originY, originY],
        z: [originZ, originZ + zLength],
        mode: 'lines',
        line: { color: 'blue', width: 6 },
        showlegend: false,
        hoverinfo: 'skip'
      }
    ];
  }, [cubeInfo]);

 const createInlineSlice = useCallback((ampRange, colorscale) => {
    const data = sliceData.inline;
    if (!data || !cubeInfo || !data.data || !data.coordinates) {
      console.log('Missing inline slice data');
      return null;
    }
    const inlineVal = cubeInfo.inline_range.min + sliceIndices.inline;
    const sliceMatrix = Array.isArray(data.data[0]) ? data.data : [data.data];
    const xlineCoords = data.coordinates.x;
    const sampleCoords = data.coordinates.y;
    const xMesh = [];
    const yMesh = [];
    const zMesh = [];
    for (let i = 0; i < sampleCoords.length; i++) {
      xMesh.push(Array(xlineCoords.length).fill(inlineVal));
      yMesh.push([...xlineCoords]);
      zMesh.push(Array(xlineCoords.length).fill(sampleCoords[i]));
    }
    return {
      type: 'surface',
      x: xMesh,
      y: yMesh,
      z: zMesh,
      surfacecolor: sliceMatrix,
      colorscale: colorscale,
      cmin: ampRange.min,
      cmax: ampRange.max,
      name: `INLINE ${inlineVal}`,
      showscale: false,
      opacity: 0.9,
      text: sliceMatrix,
      hovertemplate: '<b>INLINE Slice</b><br>' +
        'INLINE: %{x:.0f}<br>' +
        'XLINE: %{y:.0f}<br>' +
        'Sample: %{z:.2f}<br>' +
        'Amplitude: %{text:.6f}<br>' +
        '<extra></extra>'
    };
  }, [sliceData, cubeInfo, sliceIndices]);

  const createXlineSlice = useCallback((ampRange, colorscale) => {
    const data = sliceData.xline;
    if (!data || !cubeInfo || !data.data || !data.coordinates) {
      console.log('Missing xline slice data');
      return null;
    }
    const xlineVal = cubeInfo.xline_range.min + sliceIndices.xline;
    const sliceMatrix = Array.isArray(data.data[0]) ? data.data : [data.data];
    const inlineCoords = data.coordinates.x;
    const sampleCoords = data.coordinates.y;
    const xMesh = [];
    const yMesh = [];
    const zMesh = [];
    for (let i = 0; i < sampleCoords.length; i++) {
      xMesh.push([...inlineCoords]);
      yMesh.push(Array(inlineCoords.length).fill(xlineVal));
      zMesh.push(Array(inlineCoords.length).fill(sampleCoords[i]));
    }
    return {
      type: 'surface',
      x: xMesh,
      y: yMesh,
      z: zMesh,
      surfacecolor: sliceMatrix,
      colorscale: colorscale,
      cmin: ampRange.min,
      cmax: ampRange.max,
      name: `XLINE ${xlineVal}`,
      showscale: false,
      opacity: 0.9,
      text: sliceMatrix,
      hovertemplate: '<b>XLINE Slice</b><br>' +
        'INLINE: %{x:.0f}<br>' +
        'XLINE: %{y:.0f}<br>' +
        'Sample: %{z:.2f}<br>' +
        'Amplitude: %{text:.6f}<br>' +
        '<extra></extra>'
    };
  }, [sliceData, cubeInfo, sliceIndices]);

  const createSampleSlice = useCallback((ampRange, colorscale) => {
    const data = sliceData.sample;
    if (!data || !cubeInfo || !data.data || !data.coordinates) {
      console.log('Missing sample slice data');
      return null;
    }
    const sampleVal = cubeInfo.sample_range.min + sliceIndices.sample *
      (cubeInfo.sample_range.max - cubeInfo.sample_range.min) / (cubeInfo.sample_range.count - 1);
    const sliceMatrix = Array.isArray(data.data[0]) ? data.data : [data.data];
    const inlineCoords = data.coordinates.x;
    const xlineCoords = data.coordinates.y;
    const xMesh = [];
    const yMesh = [];
    const zMesh = [];
    for (let i = 0; i < inlineCoords.length; i++) {
      xMesh.push(Array(xlineCoords.length).fill(inlineCoords[i]));
      yMesh.push([...xlineCoords]);
      zMesh.push(Array(xlineCoords.length).fill(sampleVal));
    }
    return {
      type: 'surface',
      x: xMesh,
      y: yMesh,
      z: zMesh,
      surfacecolor: sliceMatrix,
      colorscale: colorscale,
      cmin: ampRange.min,
      cmax: ampRange.max,
      name: `Sample ${sampleVal.toFixed(1)}`,
      showscale: true,
      opacity: 0.9,
      text: sliceMatrix,
      colorbar: {
        title: {
          text: "Amplitude",
          side: "right"
        },
        tickmode: "auto",
        nticks: 10,
        len: 0.7,
        thickness: 20,
        x: 1.02,
        tickformat: ".2f",
        tickfont: {
          size: 12,
          color: "#2c3e50"
        }
      },
      hovertemplate: '<b>Sample Slice</b><br>' +
        'INLINE: %{x:.0f}<br>' +
        'XLINE: %{y:.0f}<br>' +
        'Sample: %{z:.2f}<br>' +
        'Amplitude: %{text:.6f}<br>' +
        '<extra></extra>'
    };
  }, [sliceData, cubeInfo, sliceIndices]);

  const create3DVisualization = useCallback(() => {
    console.log('Creating 3D visualization...');
    if (!cubeInfo || !sliceData || Object.keys(sliceData).length === 0) {
      console.log('Missing required data for visualization');
      return;
    }
    if (!plotDiv.current) {
      console.log('Plot div not ready');
      return;
    }
    try {
      setVizError(null);
      const traces = [];
      const ampRange = getAmplitudeRange();
      const colorscale = getCurrentColorscale();
      console.log('Amplitude range:', ampRange);
      console.log('Color scheme:', colorScheme);
      const cubeOutlineTraces = createCubeOutline();
      traces.push(...cubeOutlineTraces);
      console.log('Added cube outline traces:', cubeOutlineTraces.length);
      if (sliceVisibility.inline && sliceData.inline) {
        const inlineTrace = createInlineSlice(ampRange, colorscale);
        if (inlineTrace) {
          traces.push(inlineTrace);
          console.log('Added inline trace');
        }
      }
      if (sliceVisibility.xline && sliceData.xline) {
        const xlineTrace = createXlineSlice(ampRange, colorscale);
        if (xlineTrace) {
          traces.push(xlineTrace);
          console.log('Added xline trace');
        }
      }
      if (sliceVisibility.sample && sliceData.sample) {
        const sampleTrace = createSampleSlice(ampRange, colorscale);
        if (sampleTrace) {
          traces.push(sampleTrace);
          console.log('Added sample trace');
        }
      }
      const mainAxisTraces = createCoordinateAxes();
      traces.push(...mainAxisTraces);
      console.log('Added axis traces:', mainAxisTraces.length);
      console.log('Total traces:', traces.length);
      const layout = {
        title: '3D Seismic Cube Visualization',
        scene: {
          xaxis: { 
            title: 'INLINE →', 
            range: [cubeInfo.inline_range.min - 5, cubeInfo.inline_range.max + 5],
            titlefont: { size: 14, color: '#2c3e50' }
          },
          yaxis: { 
            title: 'XLINE →', 
            range: [cubeInfo.xline_range.min - 5, cubeInfo.xline_range.max + 5],
            titlefont: { size: 14, color: '#2c3e50' }
          },
          zaxis: { 
            title: '↓ Sample (Time/Depth)', 
            range: [cubeInfo.sample_range.max, cubeInfo.sample_range.min], 
            autorange: 'reversed',
            titlefont: { size: 14, color: '#2c3e50' }
          },
          camera: { eye: { x: 1.8, y: 1.8, z: 1.5 } },
          aspectratio: { x: 1, y: 1, z: 0.8 }
        },
        annotations: [
          {
            text: `<b>Survey Orientation</b><br>INLINE Azimuth: ${cubeInfo.geometry?.inline_azimuth?.toFixed(1) || 'N/A'}° from North<br>XLINE Azimuth: ${cubeInfo.geometry?.xline_azimuth?.toFixed(1) || 'N/A'}° from North`,
            xref: 'paper',
            yref: 'paper',
            x: 0.02,
            y: 0.98,
            xanchor: 'left',
            yanchor: 'top',
            showarrow: false,
            bgcolor: 'rgba(255, 255, 255, 0.8)',
            bordercolor: '#2c3e50',
            borderwidth: 1,
            borderpad: 8,
            font: { size: 11, color: '#2c3e50' }
          }
        ],
        width: 1000,
        height: 700,
        margin: { r: 80, b: 10, l: 10, t: 60 }
      };
      console.log('Calling Plotly.newPlot...');
      Plotly.newPlot(plotDiv.current, traces, layout, {
        displayModeBar: true,
        responsive: true
      }).then(() => {
        console.log('✓ Plotly plot created successfully');
      }).catch(err => {
        console.error('✗ Plotly error:', err);
        setVizError('Plotly rendering error: ' + err.message);
      });
    } catch (err) {
      console.error('✗ Visualization error:', err);
      setVizError('Failed to create visualization: ' + err.message);
    }
  }, [cubeInfo, sliceData, sliceVisibility, sliceIndices, createCubeOutline, createCoordinateAxes, createInlineSlice, createXlineSlice, createSampleSlice, colorScheme, getCurrentColorscale]);

  useEffect(() => {
    console.log('useEffect triggered - creating visualization');
    create3DVisualization();
  }, [create3DVisualization]);

  return (
    <div style={{ fontFamily: 'Arial, sans-serif', maxWidth: '1400px', margin: '0 auto', padding: '20px' }}>
      <div style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h1 style={{ color: '#2c3e50', marginBottom: '10px' }}>3D Seismic Cube Viewer</h1>
       
       
      </div>

      <div style={{ backgroundColor: '#f8f9fa', padding: '20px', borderRadius: '8px', marginBottom: '20px' }}>
        <input
          type="file"
          multiple
          accept=".segy,.sgy,.zip"
          onChange={handleFileUpload}
          style={{ display: 'none' }}
          id="file-upload"
        />
        <label
          htmlFor="file-upload"
          style={{
            backgroundColor: '#3498db',
            color: 'white',
            padding: '12px 24px',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '16px',
            display: 'inline-block'
          }}
        >
          Choose Files
        </label>
        
        {files.length > 0 && (
          <div style={{ marginTop: '15px' }}>
            <h3 style={{ marginBottom: '10px', color: '#2c3e50' }}>Selected Files:</h3>
            <ul style={{ margin: 0, paddingLeft: '20px' }}>
              {files.map((file, index) => (
                <li key={index} style={{ marginBottom: '5px', color: '#34495e' }}>
                  {file.name} ({(file.size / (1024 * 1024)).toFixed(2)} MB)
                </li>
              ))}
            </ul>
          </div>
        )}
       
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: '40px' }}>
          <div style={{
            border: '4px solid #f3f3f3',
            borderTop: '4px solid #3498db',
            borderRadius: '50%',
            width: '40px',
            height: '40px',
            animation: 'spin 1s linear infinite',
            margin: '0 auto 20px'
          }}></div>
          <p style={{ color: '#7f8c8d' }}>Processing seismic data...</p>
        </div>
      )}

      {error && (
        <div style={{
          backgroundColor: '#e74c3c',
          color: 'white',
          padding: '15px',
          borderRadius: '6px',
          marginBottom: '20px'
        }}>
          <p style={{ margin: 0 }}>Error: {error}</p>
        </div>
      )}

      {vizError && (
        <div style={{
          backgroundColor: '#f39c12',
          color: 'white',
          padding: '15px',
          borderRadius: '6px',
          marginBottom: '20px'
        }}>
          <p style={{ margin: 0 }}>Visualization Error: {vizError}</p>
        </div>
      )}

      {cubeInfo && !loading && (
        <div style={{ display: 'flex', gap: '20px', alignItems: 'flex-start' }}>
          <div style={{
            backgroundColor: '#f8f9fa',
            padding: '20px',
            borderRadius: '8px',
            minWidth: '280px',
            maxWidth: '300px'
          }}>
            <h3 style={{ color: '#2c3e50', marginBottom: '20px' }}>Control Panel</h3>

            <div style={{ marginBottom: '25px' }}>
              <h4 style={{ color: '#34495e', marginBottom: '15px' }}>Color Scheme</h4>
              <div style={{ marginBottom: '10px' }}>
                <select
                  value={colorScheme}
                  onChange={(e) => setColorScheme(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '8px',
                    borderRadius: '4px',
                    border: '1px solid #bbb',
                    fontSize: '14px'
                  }}
                >
                  <option value="seismic">Seismic</option>
                  <option value="viridis">Viridis</option>
                  <option value="hot">Hot</option>
                  <option value="cool">Cool</option>
                  <option value="grayscale">Grayscale</option>
                  <option value="jet">Jet</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              {colorScheme === 'custom' && (
                <button
                  onClick={() => setShowColorCustomizer(!showColorCustomizer)}
                  style={{
                    width: '100%',
                    padding: '8px',
                    backgroundColor: '#e67e22',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
                >
                  {showColorCustomizer ? 'Hide' : 'Show'} Customizer
                </button>
              )}
            </div>

            {showColorCustomizer && colorScheme === 'custom' && (
              <div style={{ marginBottom: '25px', padding: '15px', backgroundColor: '#fff3cd', borderRadius: '6px' }}>
                <h4 style={{ color: '#856404', marginTop: 0, marginBottom: '12px' }}>Custom Colors</h4>
                <div style={{ maxHeight: '250px', overflowY: 'auto', marginBottom: '10px' }}>
                  {customColors.map((color, index) => (
                    <div key={index} style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
                      <input
                        type="color"
                        value={color}
                        onChange={(e) => handleColorChange(index, e.target.value)}
                        style={{ width: '50px', height: '40px', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                      />
                      <span style={{ fontSize: '12px', color: '#333', flex: 1 }}>{color}</span>
                      <button
                        onClick={() => removeColorFromCustom(index)}
                        disabled={customColors.length <= 2}
                        style={{
                          padding: '4px 8px',
                          backgroundColor: customColors.length <= 2 ? '#ccc' : '#e74c3c',
                          color: 'white',
                          border: 'none',
                          borderRadius: '3px',
                          cursor: customColors.length <= 2 ? 'not-allowed' : 'pointer',
                          fontSize: '12px'
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  onClick={addColorToCustom}
                  style={{
                    width: '100%',
                    padding: '8px',
                    backgroundColor: '#27ae60',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '14px'
                  }}
                >
                  Add Color
                </button>
              </div>
            )}

            <div style={{ marginBottom: '25px' }}>
              <h4 style={{ color: '#34495e', marginBottom: '15px' }}>Navigation</h4>
              <div>
                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                    INLINE: {cubeInfo.inline_range.min + sliceIndices.inline}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={cubeInfo.shape[0] - 1}
                    value={sliceIndices.inline}
                    onChange={(e) => handleSliceChange('inline', parseInt(e.target.value))}
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                    XLINE: {cubeInfo.xline_range.min + sliceIndices.xline}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={cubeInfo.shape[1] - 1}
                    value={sliceIndices.xline}
                    onChange={(e) => handleSliceChange('xline', parseInt(e.target.value))}
                    style={{ width: '100%' }}
                  />
                </div>

                <div style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
                    Sample: {(cubeInfo.sample_range.min + sliceIndices.sample * (cubeInfo.sample_range.max - cubeInfo.sample_range.min) / (cubeInfo.sample_range.count - 1)).toFixed(1)}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={cubeInfo.shape[2] - 1}
                    value={sliceIndices.sample}
                    onChange={(e) => handleSliceChange('sample', parseInt(e.target.value))}
                    style={{ width: '100%' }}
                  />
                </div>
              </div>
            </div>

            <div>
              <h4 style={{ color: '#34495e', marginBottom: '15px' }}>Slice Visibility</h4>
              <div>
                <label style={{ display: 'block', marginBottom: '8px' }}>
                  <input
                    type="checkbox"
                    checked={sliceVisibility.inline}
                    onChange={() => handleVisibilityChange('inline')}
                    style={{ marginRight: '8px' }}
                  />
                  INLINE Slice
                </label>
                <label style={{ display: 'block', marginBottom: '8px' }}>
                  <input
                    type="checkbox"
                    checked={sliceVisibility.xline}
                    onChange={() => handleVisibilityChange('xline')}
                    style={{ marginRight: '8px' }}
                  />
                  XLINE Slice
                </label>
                <label style={{ display: 'block', marginBottom: '8px' }}>
                  <input
                    type="checkbox"
                    checked={sliceVisibility.sample}
                    onChange={() => handleVisibilityChange('sample')}
                    style={{ marginRight: '8px' }}
                  />
                  Sample Slice
                </label>
              </div>
            </div>

            {cubeInfo.amplitude_range && (
              <div style={{ marginTop: '20px', padding: '15px', backgroundColor: '#e8f4f8', borderRadius: '6px' }}>
                <h4 style={{ color: '#2c3e50', margin: '0 0 10px 0' }}>Amplitude Statistics</h4>
                <div style={{ fontSize: '12px', color: '#34495e', lineHeight: '1.6' }}>
                  <div style={{ marginBottom: '8px' }}>
                    <strong>Actual Range:</strong>
                  </div>
                  <div style={{ paddingLeft: '10px' }}>
                    Min: {cubeInfo.amplitude_range.actual_min?.toFixed(6) || 'N/A'}<br />
                    Max: {cubeInfo.amplitude_range.actual_max?.toFixed(6) || 'N/A'}
                  </div>
                  <div style={{ marginTop: '8px', marginBottom: '4px' }}>
                    <strong>Display Range (p5-p95):</strong>
                  </div>
                  <div style={{ paddingLeft: '10px' }}>
                    Min: {cubeInfo.amplitude_range.display_min?.toFixed(6) || 'N/A'}<br />
                    Max: {cubeInfo.amplitude_range.display_max?.toFixed(6) || 'N/A'}
                  </div>
                  <div style={{ marginTop: '8px', marginBottom: '4px' }}>
                    <strong>Statistics:</strong>
                  </div>
                  <div style={{ paddingLeft: '10px' }}>
                    Mean: {cubeInfo.amplitude_range.mean?.toFixed(6) || 'N/A'}<br />
                    Std: {cubeInfo.amplitude_range.std?.toFixed(6) || 'N/A'}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div style={{ flex: 1, minWidth: '800px' }}>
            <div
              ref={plotDiv}
              style={{
                width: '100%',
                height: '700px',
                border: '1px solid #ddd',
                borderRadius: '8px',
                backgroundColor: 'white'
              }}
            />

            <div style={{
              backgroundColor: '#f8f9fa',
              padding: '20px',
              borderRadius: '8px',
              marginTop: '20px'
            }}>
              <h3 style={{ color: '#2c3e50', marginBottom: '15px' }}>Data Information</h3>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '15px' }}>
                <div>
                  <strong>Cube Dimensions:</strong> {cubeInfo.shape.join(' × ')}
                </div>
                <div>
                  <strong>INLINE Range:</strong> {cubeInfo.inline_range.min} to {cubeInfo.inline_range.max}
                </div>
                <div>
                  <strong>XLINE Range:</strong> {cubeInfo.xline_range.min} to {cubeInfo.xline_range.max}
                </div>
                <div>
                  <strong>Sample Range:</strong> {cubeInfo.sample_range.min.toFixed(1)} to {cubeInfo.sample_range.max.toFixed(1)}
                </div>
                <div>
                  <strong>Memory Usage:</strong> {cubeInfo.memory_usage_mb.toFixed(1)} MB
                </div>
              </div>

              
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }

        input[type="range"] {
          -webkit-appearance: none;
          width: 100%;
          height: 6px;
          borderRadius: 3px;
          background: #ddd;
          outline: none;
        }

        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 18px;
          height: 18px;
          borderRadius: 50%;
          background: #3498db;
          cursor: pointer;
        }

        input[type="range"]::-moz-range-thumb {
          width: 18px;
          height: 18px;
          borderRadius: 50%;
          background: #3498db;
          cursor: pointer;
          border: none;
        }
      `}</style>
    </div>
  );
};

export default SeismicViewer;