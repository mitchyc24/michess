

class Game():
    def __init__(self):
        self.white_to_move = True
        self.layout = ["rnbqkbnr","pppppppp","xxxxxxxx","xxxxxxxx","xxxxxxxx","xxxxxxxx","PPPPPPPPP","RNBQKBNR"]

    def iter_squares(self):
        for row in range(8):
            for col in range(8):
                yield ((row,col), self.layout[row][col])