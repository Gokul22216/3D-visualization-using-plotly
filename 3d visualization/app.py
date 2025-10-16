from flask import Flask, request, jsonify
from flask_cors import CORS
import os
import numpy as np
import segyio
import warnings
import zipfile
import tempfile
import shutil
from werkzeug.utils import secure_filename
from pymongo import MongoClient
from bson import ObjectId
from datetime import datetime
from dotenv import load_dotenv
import traceback

warnings.filterwarnings('ignore')

# Load environment variables
load_dotenv()

app = Flask(__name__)
CORS(app)

# Configuration
UPLOAD_FOLDER = 'uploads'
ALLOWED_EXTENSIONS = {'segy', 'sgy', 'zip'}

app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024 

os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# MongoDB Configuration
MONGO_URI = os.getenv('MONGO_URI', 'mongodb://localhost:27017/')
MONGO_DB_NAME = os.getenv('MONGO_DB_NAME', 'seismic_viewer')

print(f"\n{'='*60}")
print(f"MongoDB Configuration:")
print(f"URI: {MONGO_URI}")
print(f"Database: {MONGO_DB_NAME}")
print(f"{'='*60}\n")

# Initialize MongoDB client
mongo_client = None
db = None
cubes_collection = None
sessions_collection = None

try:
    print("Attempting to connect to MongoDB...")
    mongo_client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    
    # Test connection
    server_info = mongo_client.server_info()
    print(f"MongoDB Server Version: {server_info.get('version', 'unknown')}")
    
    db = mongo_client[MONGO_DB_NAME]
    cubes_collection = db['cubes']
    sessions_collection = db['sessions']
    
    # Create indexes for better query performance
    cubes_collection.create_index([("session_id", 1)])
    cubes_collection.create_index([("created_at", -1)])
    
    # Test write operation
    test_doc = {'_test': True, 'timestamp': datetime.utcnow()}
    test_result = cubes_collection.insert_one(test_doc)
    cubes_collection.delete_one({'_id': test_result.inserted_id})
    
    print("✓ MongoDB connected successfully")
    print(f"✓ Database '{MONGO_DB_NAME}' accessible")
    print(f"✓ Collection 'cubes' ready")
    
except Exception as e:
    print(f"✗ MongoDB connection failed: {e}")
    print(f"✗ Error type: {type(e).__name__}")
    traceback.print_exc()
    print("  The application will run but data won't persist to MongoDB")

class SeismicCubeProcessor:
    def __init__(self):
        self.data = None
        self.inline_range = None
        self.xline_range = None
        self.sample_range = None
        self.amplitude_range = None
        self.current_inline_idx = 0
        self.current_xline_idx = 0
        self.current_sample_idx = 0
        self.inline_coords = None
        self.xline_coords = None
        self.sample_coords = None
        self.session_id = None
        self.cube_id = None
        
    def load_segy_file(self, filepath):
        try:
            print(f"\n{'='*60}")
            print(f"Loading SEGY file: {filepath}")
            print(f"{'='*60}")
            
            with segyio.open(filepath, ignore_geometry=True) as f:
                n_traces = len(f.trace)
                n_samples = len(f.samples)
                
                print(f"Total traces: {n_traces:,}")
                print(f"Samples per trace: {n_samples:,}")
                
                self.sample_coords = np.array(f.samples)
                
                inlines = []
                xlines = []
                x_coords = []
                y_coords = []
                
                print("Reading trace headers...")
                for i in range(n_traces):
                    try:
                        header = f.header[i]
                        inline = header[segyio.TraceField.INLINE_3D]
                        xline = header[segyio.TraceField.CROSSLINE_3D]
                        
                        # Get X and Y coordinates for survey geometry
                        try:
                            x_coord = header[segyio.TraceField.CDP_X]
                            y_coord = header[segyio.TraceField.CDP_Y]
                            # Some files use SourceX/SourceY instead
                            if x_coord == 0 and y_coord == 0:
                                x_coord = header[segyio.TraceField.SourceX]
                                y_coord = header[segyio.TraceField.SourceY]
                        except:
                            x_coord = 0
                            y_coord = 0
                        
                        if inline != 0 and xline != 0:
                            inlines.append(inline)
                            xlines.append(xline)
                            x_coords.append(x_coord)
                            y_coords.append(y_coord)
                        else:
                            grid_size = int(np.sqrt(n_traces))
                            inlines.append(i // grid_size + 1)
                            xlines.append(i % grid_size + 1)
                            x_coords.append(0)
                            y_coords.append(0)
                            
                    except Exception:
                        grid_size = int(np.sqrt(n_traces))
                        inlines.append(i // grid_size + 1)
                        xlines.append(i % grid_size + 1)
                        x_coords.append(0)
                        y_coords.append(0)
                
                unique_inlines = sorted(list(set(inlines)))
                unique_xlines = sorted(list(set(xlines)))
                
                print(f"INLINE range: {min(unique_inlines)} - {max(unique_inlines)} ({len(unique_inlines)} lines)")
                print(f"XLINE range: {min(unique_xlines)} - {max(unique_xlines)} ({len(unique_xlines)} lines)")
                
                self.inline_coords = np.array(unique_inlines)
                self.xline_coords = np.array(unique_xlines)
                
                # Calculate survey geometry
                geometry_info = self.calculate_survey_geometry(inlines, xlines, x_coords, y_coords, unique_inlines, unique_xlines)
                
                print("Building 3D data cube...")
                self.data = np.zeros((len(unique_inlines), len(unique_xlines), n_samples))
                
                inline_map = {il: idx for idx, il in enumerate(unique_inlines)}
                xline_map = {xl: idx for idx, xl in enumerate(unique_xlines)}
                
                for i in range(min(n_traces, len(inlines))):
                    try:
                        inline = inlines[i]
                        xline = xlines[i]
                        
                        if inline in inline_map and xline in xline_map:
                            inline_idx = inline_map[inline]
                            xline_idx = xline_map[xline]
                            
                            trace_data = np.array(f.trace[i])
                            trace_data = np.nan_to_num(trace_data, nan=0.0, posinf=0.0, neginf=0.0)
                            
                            self.data[inline_idx, xline_idx, :] = trace_data
                            
                    except Exception:
                        continue
                
                self.inline_range = np.array(unique_inlines)
                self.xline_range = np.array(unique_xlines)
                self.sample_range = self.sample_coords
                self.geometry = geometry_info
                
                print("Calculating amplitude statistics...")
                
                clean_data = np.nan_to_num(self.data, nan=0.0, posinf=0.0, neginf=0.0)
                
                data_min = float(np.min(clean_data))
                data_max = float(np.max(clean_data))
                data_mean = float(np.mean(clean_data))
                data_std = float(np.std(clean_data))
                
                p1 = float(np.percentile(clean_data, 1))
                p99 = float(np.percentile(clean_data, 99))
                p5 = float(np.percentile(clean_data, 5))
                p95 = float(np.percentile(clean_data, 95))
                
                self.amplitude_range = {
                    'actual_min': data_min,
                    'actual_max': data_max,
                    'display_min': p5,
                    'display_max': p95,
                    'mean': data_mean,
                    'std': data_std,
                    'p1': p1,
                    'p99': p99,
                    'p5': p5,
                    'p95': p95
                }
                
                self.current_inline_idx = len(self.inline_range) // 2
                self.current_xline_idx = len(self.xline_range) // 2 
                self.current_sample_idx = len(self.sample_range) // 2
                
                print("✓ SEGY file loaded successfully!")
                print(f"  Data shape: {self.data.shape}")
                print(f"  Actual amplitude range: {data_min:.6f} to {data_max:.6f}")
                print(f"  Display amplitude range (p5-p95): {p5:.6f} to {p95:.6f}")
                print(f"  Mean: {data_mean:.6f}, Std: {data_std:.6f}")
                print(f"  Memory usage: {self.data.nbytes / (1024**2):.1f} MB")
                if geometry_info:
                    print(f"  Survey orientation: {geometry_info.get('inline_azimuth', 0):.1f}° from North")
                print(f"{'='*60}\n")
                
                return True
                
        except Exception as e:
            print(f"✗ Error loading SEGY file: {str(e)}")
            traceback.print_exc()
            return False
    
    def calculate_survey_geometry(self, inlines, xlines, x_coords, y_coords, unique_inlines, unique_xlines):
        """Calculate survey geometry and orientation more robustly."""
        try:
            # Create a dictionary for quick lookup of coordinates
            coord_map = {(il, xl): (x, y) for il, xl, x, y in zip(inlines, xlines, x_coords, y_coords) if x != 0 and y != 0}

            if len(coord_map) < 4:
                print("  Warning: Insufficient coordinate data for geometry calculation.")
                return {'inline_azimuth': 0.0, 'xline_azimuth': 90.0, 'has_coordinates': False}

            min_il, max_il = min(unique_inlines), max(unique_inlines)
            min_xl, max_xl = min(unique_xlines), max(unique_xlines)

            # --- Get points for INLINE azimuth calculation ---
            # Try to find points along the first crossline
            p1_il_coords = coord_map.get((min_il, min_xl))
            p2_il_coords = coord_map.get((max_il, min_xl))
            
            # Fallback if points are missing
            if not p1_il_coords or not p2_il_coords:
                print("  Warning: Corner points missing for inline. Using first available points.")
                # Find any two points on the same crossline but different inlines
                for xl_val in unique_xlines:
                    p1_il_coords = coord_map.get((min_il, xl_val))
                    p2_il_coords = coord_map.get((max_il, xl_val))
                    if p1_il_coords and p2_il_coords:
                        break

            # --- Get points for XLINE azimuth calculation ---
            # Try to find points along the first inline
            p1_xl_coords = coord_map.get((min_il, min_xl))
            p2_xl_coords = coord_map.get((min_il, max_xl))

            # Fallback if points are missing
            if not p1_xl_coords or not p2_xl_coords:
                print("  Warning: Corner points missing for xline. Using first available points.")
                # Find any two points on the same inline but different crosslines
                for il_val in unique_inlines:
                    p1_xl_coords = coord_map.get((il_val, min_xl))
                    p2_xl_coords = coord_map.get((il_val, max_xl))
                    if p1_xl_coords and p2_xl_coords:
                        break

            # --- Calculate Azimuths ---
            inline_azimuth = 0.0
            if p1_il_coords and p2_il_coords:
                dx = p2_il_coords[0] - p1_il_coords[0]
                dy = p2_il_coords[1] - p1_il_coords[1]
                inline_azimuth = (np.degrees(np.arctan2(dx, dy)) + 360) % 360

            xline_azimuth = 90.0
            if p1_xl_coords and p2_xl_coords:
                dx = p2_xl_coords[0] - p1_xl_coords[0]
                dy = p2_xl_coords[1] - p1_xl_coords[1]
                xline_azimuth = (np.degrees(np.arctan2(dx, dy)) + 360) % 360
            
            geometry = {
                'inline_azimuth': float(inline_azimuth),
                'xline_azimuth': float(xline_azimuth),
                'has_coordinates': True
            }
            
            print(f"  Survey geometry calculated:")
            print(f"    INLINE azimuth: {inline_azimuth:.1f}° from North")
            print(f"    XLINE azimuth: {xline_azimuth:.1f}° from North")
            
            return geometry

        except Exception as e:
            print(f"  Warning: Could not calculate survey geometry: {e}")
            return {'inline_azimuth': 0.0, 'xline_azimuth': 90.0, 'has_coordinates': False}
    
    def save_metadata_to_mongodb(self, filename):
        """Save cube metadata to MongoDB with detailed logging"""
        print(f"\n{'='*60}")
        print(f"Attempting to save metadata to MongoDB...")
        print(f"{'='*60}")
        
        if cubes_collection is None:
            print("✗ MongoDB collection is None - connection failed")
            print("  Skipping metadata save")
            return None
        
        print(f"✓ MongoDB collection available")
        print(f"  Filename: {filename}")
        print(f"  Session ID: {self.session_id}")
            
        try:
            cube_info = self.get_cube_info()
            
            if cube_info is None:
                print("✗ Failed to get cube_info")
                return None
            
            print(f"✓ Cube info retrieved successfully")
            print(f"  Shape: {cube_info['shape']}")
            
            document = {
                'filename': filename,
                'session_id': self.session_id,
                'cube_info': cube_info,
                'created_at': datetime.utcnow(),
                'updated_at': datetime.utcnow()
            }
            
            print(f"  Document prepared, inserting...")
            
            result = cubes_collection.insert_one(document)
            self.cube_id = str(result.inserted_id)
            
            print(f"✓ Metadata saved to MongoDB")
            print(f"  Cube ID: {self.cube_id}")
            
            # Verify the document was saved
            verify = cubes_collection.find_one({'_id': result.inserted_id})
            if verify:
                print(f"✓ Document verified in database")
            else:
                print(f"✗ Warning: Document not found after insert")
            
            # Count total documents
            total_docs = cubes_collection.count_documents({})
            print(f"  Total documents in collection: {total_docs}")
            print(f"{'='*60}\n")
            
            return self.cube_id
            
        except Exception as e:
            print(f"✗ Error saving to MongoDB: {str(e)}")
            print(f"  Error type: {type(e).__name__}")
            traceback.print_exc()
            print(f"{'='*60}\n")
            return None
    
    def load_metadata_from_mongodb(self, cube_id):
        """Load cube metadata from MongoDB"""
        if cubes_collection is None:
            return None
            
        try:
            document = cubes_collection.find_one({'_id': ObjectId(cube_id)})
            if document:
                return document['cube_info']
            return None
        except Exception as e:
            print(f"Error loading from MongoDB: {str(e)}")
            return None
    
    def update_metadata_in_mongodb(self):
        """Update existing cube metadata in MongoDB"""
        if not self.cube_id or cubes_collection is None:
            return False
        
        try:
            cube_info = self.get_cube_info()
            cubes_collection.update_one(
                {'_id': ObjectId(self.cube_id)},
                {
                    '$set': {
                        'cube_info': cube_info,
                        'updated_at': datetime.utcnow()
                    }
                }
            )
            print(f"✓ Metadata updated in MongoDB")
            return True
        except Exception as e:
            print(f"Error updating MongoDB: {str(e)}")
            return False
    
    def get_slice_data(self, slice_type, index):
        """Get slice data for visualization with proper coordinate mapping"""
        if self.data is None:
            print(f"✗ get_slice_data called but self.data is None")
            return None
        
        try:
            if slice_type == 'inline':
                data = self.data[index, :, :]
                coords = {
                    'x': self.xline_coords.tolist(),
                    'y': self.sample_coords.tolist()
                }
                
            elif slice_type == 'xline':
                data = self.data[:, index, :]
                coords = {
                    'x': self.inline_coords.tolist(),
                    'y': self.sample_coords.tolist()
                }
                
            elif slice_type == 'sample':
                data = self.data[:, :, index]
                coords = {
                    'x': self.inline_coords.tolist(),
                    'y': self.xline_coords.tolist()
                }
            else:
                return None
            
            # Clean the data
            data = np.array(data)
            data = np.nan_to_num(data, nan=0.0, posinf=0.0, neginf=0.0)
            
            # Transpose for inline and xline to match visualization orientation
            if slice_type in ['inline', 'xline']:
                data = data.T
            
            print(f"✓ Slice data prepared: {slice_type}[{index}], shape: {data.shape}")
            print(f"  Data range: {np.min(data):.6f} to {np.max(data):.6f}")
            
            return {
                'data': data.tolist(),
                'coordinates': coords,
                'amplitude_stats': {
                    'min': float(np.min(data)),
                    'max': float(np.max(data)),
                    'mean': float(np.mean(data)),
                    'std': float(np.std(data))
                }
            }
            
        except Exception as e:
            print(f"✗ Error getting slice data: {str(e)}")
            traceback.print_exc()
            return None
    
    def get_cube_info(self):
        """Get cube information with improved metadata"""
        if self.data is None:
            print("✗ get_cube_info called but self.data is None")
            return None
        
        try:
            info = {
                'shape': list(self.data.shape),
                'inline_range': {
                    'min': int(self.inline_range.min()),
                    'max': int(self.inline_range.max()),
                    'count': len(self.inline_range)
                },
                'xline_range': {
                    'min': int(self.xline_range.min()),
                    'max': int(self.xline_range.max()),
                    'count': len(self.xline_range)
                },
                'sample_range': {
                    'min': float(self.sample_range.min()),
                    'max': float(self.sample_range.max()),
                    'count': len(self.sample_range)
                },
                'amplitude_range': self.amplitude_range,
                'memory_usage_mb': float(self.data.nbytes / (1024**2)),
                'geometry': getattr(self, 'geometry', {
                    'inline_azimuth': 0.0,
                    'xline_azimuth': 90.0,
                    'has_coordinates': False
                })
            }
            return info
            
        except Exception as e:
            print(f"✗ Error getting cube info: {str(e)}")
            traceback.print_exc()
            return None

processor = SeismicCubeProcessor()

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def extract_segy_files(zip_path, extract_to):
    """Extract SEGY files from ZIP archive"""
    segy_files = []
    try:
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            for file_info in zip_ref.infolist():
                if file_info.filename.lower().endswith(('.segy', '.sgy')):
                    zip_ref.extract(file_info, extract_to)
                    extracted_path = os.path.join(extract_to, file_info.filename)
                    segy_files.append(extracted_path)
                    print(f"Extracted: {file_info.filename}")
    except Exception as e:
        print(f"Error extracting ZIP file: {e}")
    
    return segy_files

# API Routes

@app.route('/api/upload', methods=['POST'])
def upload_file():
    """Handle file upload and processing"""
    print(f"\n{'='*60}")
    print(f"Upload request received")
    print(f"{'='*60}")
    
    if 'files' not in request.files:
        return jsonify({'error': 'No files provided'}), 400
    
    files = request.files.getlist('files')
    if not files or all(file.filename == '' for file in files):
        return jsonify({'error': 'No files selected'}), 400
    
    # Generate session ID
    session_id = str(ObjectId())
    processor.session_id = session_id
    print(f"Generated session ID: {session_id}")
    
    uploaded_files = []
    segy_files = []
    temp_dir = tempfile.mkdtemp()
    
    try:
        for file in files:
            if file and allowed_file(file.filename):
                filename = secure_filename(file.filename)
                filepath = os.path.join(app.config['UPLOAD_FOLDER'], filename)
                file.save(filepath)
                uploaded_files.append(filepath)
                print(f"Saved file: {filename}")
                
                if filename.lower().endswith('.zip'):
                    extracted_files = extract_segy_files(filepath, temp_dir)
                    segy_files.extend(extracted_files)
                else:
                    segy_files.append(filepath)
        
        if not segy_files:
            return jsonify({'error': 'No SEGY files found in uploaded files'}), 400
        
        first_segy = segy_files[0]
        print(f"Processing SEGY file: {os.path.basename(first_segy)}")
        
        success = processor.load_segy_file(first_segy)
        
        if success:
            # Save metadata to MongoDB
            cube_id = processor.save_metadata_to_mongodb(os.path.basename(first_segy))
            
            cube_info = processor.get_cube_info()
            if cube_info:
                response_data = {
                    'message': 'Files uploaded and processed successfully',
                    'files': [os.path.basename(f) for f in segy_files],
                    'cube_info': cube_info,
                    'cube_id': cube_id,
                    'session_id': session_id,
                    'mongodb_connected': cubes_collection is not None
                }
                print(f"\n✓ Upload successful")
                print(f"  Cube ID: {cube_id}")
                print(f"  MongoDB Connected: {cubes_collection is not None}")
                print(f"{'='*60}\n")
                
                return jsonify(response_data)
            else:
                return jsonify({'error': 'Failed to get cube information'}), 500
        else:
            return jsonify({'error': 'Failed to process SEGY file'}), 500
    
    except Exception as e:
        print(f"✗ Upload error: {str(e)}")
        traceback.print_exc()
        return jsonify({'error': f'Upload failed: {str(e)}'}), 500
    
    finally:
        if os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)

@app.route('/api/cube-info', methods=['GET'])
def get_cube_info():
    """Get current cube information"""
    cube_info = processor.get_cube_info()
    if cube_info:
        return jsonify(cube_info)
    else:
        return jsonify({'error': 'No cube data loaded'}), 400

@app.route('/api/slice/<slice_type>/<int:index>', methods=['GET'])
def get_slice(slice_type, index):
    """Get slice data for visualization"""
    if slice_type not in ['inline', 'xline', 'sample']:
        return jsonify({'error': 'Invalid slice type. Must be inline, xline, or sample'}), 400
    
    if processor.data is None:
        return jsonify({'error': 'No cube data loaded'}), 400
    
    max_indices = {
        'inline': processor.data.shape[0] - 1,
        'xline': processor.data.shape[1] - 1,
        'sample': processor.data.shape[2] - 1
    }
    
    if index < 0 or index > max_indices[slice_type]:
        return jsonify({'error': f'Index {index} out of bounds for {slice_type} (max: {max_indices[slice_type]})'}), 400
    
    slice_data = processor.get_slice_data(slice_type, index)
    if slice_data:
        return jsonify(slice_data)
    else:
        return jsonify({'error': 'Failed to get slice data'}), 500

@app.route('/api/cubes', methods=['GET'])
def list_cubes():
    """List all stored cubes from MongoDB"""
    if cubes_collection is None:
        return jsonify({'error': 'MongoDB not connected', 'cubes': []}), 200
    
    try:
        cubes = list(cubes_collection.find().sort('created_at', -1).limit(50))
        
        for cube in cubes:
            cube['_id'] = str(cube['_id'])
            if 'created_at' in cube:
                cube['created_at'] = cube['created_at'].isoformat()
            if 'updated_at' in cube:
                cube['updated_at'] = cube['updated_at'].isoformat()
        
        print(f"Listed {len(cubes)} cubes from MongoDB")
        return jsonify({'cubes': cubes, 'count': len(cubes)})
    except Exception as e:
        print(f"Error listing cubes: {str(e)}")
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/api/cube/<cube_id>', methods=['GET'])
def get_cube_by_id(cube_id):
    """Get specific cube metadata by ID"""
    if cubes_collection is None:
        return jsonify({'error': 'MongoDB not connected'}), 503
    
    try:
        cube = cubes_collection.find_one({'_id': ObjectId(cube_id)})
        if cube:
            cube['_id'] = str(cube['_id'])
            if 'created_at' in cube:
                cube['created_at'] = cube['created_at'].isoformat()
            if 'updated_at' in cube:
                cube['updated_at'] = cube['updated_at'].isoformat()
            return jsonify(cube)
        else:
            return jsonify({'error': 'Cube not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/cube/<cube_id>', methods=['DELETE'])
def delete_cube(cube_id):
    """Delete cube metadata from MongoDB"""
    if cubes_collection is None:
        return jsonify({'error': 'MongoDB not connected'}), 503
    
    try:
        result = cubes_collection.delete_one({'_id': ObjectId(cube_id)})
        if result.deleted_count > 0:
            print(f"✓ Deleted cube: {cube_id}")
            return jsonify({'message': 'Cube deleted successfully'})
        else:
            return jsonify({'error': 'Cube not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/health', methods=['GET'])
def health_check():
    """Health check endpoint"""
    mongodb_status = 'connected' if cubes_collection is not None else 'disconnected'
    
    return jsonify({
        'status': 'healthy',
        'message': 'Seismic Cube Viewer API is running',
        'data_loaded': processor.data is not None,
        'mongodb_status': mongodb_status,
        'mongodb_uri': MONGO_URI if mongodb_status == 'connected' else 'Not configured'
    })

@app.errorhandler(413)
def too_large(e):
    return jsonify({'error': 'File too large. Maximum size is 500MB.'}), 413

@app.errorhandler(500)
def internal_error(e):
    return jsonify({'error': 'Internal server error'}),500

@app.errorhandler(404)
def not_found(e):
    return jsonify({'error': 'Endpoint not found'}), 404

if __name__ == '__main__':
    print("\n" + "=" * 60)
    print("Starting Seismic Cube Viewer API...")
    print("=" * 60)
    print(f"Upload folder: {os.path.abspath(UPLOAD_FOLDER)}")
    print("Supported file types: .segy, .sgy, .zip")
    print("Max file size: 500MB")
    print(f"MongoDB Status: {'✓ Connected' if cubes_collection is not None else '✗ Disconnected'}")
    
    if cubes_collection is not None:
        print(f"MongoDB URI: {MONGO_URI}")
        print(f"Database: {MONGO_DB_NAME}")
        try:
            doc_count = cubes_collection.count_documents({})
            print(f"Existing documents: {doc_count}")
        except:
            pass
    
    print("\nAPI endpoints:")
    print("  POST   /api/upload - Upload SEGY files")
    print("  GET    /api/cube-info - Get current cube information")
    print("  GET    /api/slice/<type>/<index> - Get slice data")
    print("  GET    /api/cubes - List all stored cubes")
    print("  GET    /api/cube/<id> - Get cube by ID")
    print("  DELETE /api/cube/<id> - Delete cube")
    print("  GET    /api/health - Health check")
    print("=" * 60 + "\n")
    
    app.run(debug=True, host='0.0.0.0', port=5000)